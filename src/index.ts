import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as artifact from '@actions/artifact';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as path from 'path';

interface ActionInputs {
  kernelPath: string;
  buildTarget: string;
  nixCommand: 'build' | 'run';
  verbose: boolean;
  artifactName: string;
  uploadArtifact: boolean;
  cachixName: string;
  cachixAuthToken: string;
  nixMaxJobs: string;
  nixCores: string;
  sandboxMode: string;
  extraNixConf: string;
  hfToken: string;
  hfRepo: string;
  publish: boolean;
}

function getInputs(): ActionInputs {
  const nixCommand = core.getInput('nix-command') || 'build';
  if (nixCommand !== 'build' && nixCommand !== 'run') {
    throw new Error(`Invalid nix-command: ${nixCommand}. Must be 'build' or 'run'.`);
  }

  return {
    kernelPath: core.getInput('kernel-path') || '.',
    buildTarget: core.getInput('build-target') || 'ci',
    nixCommand,
    verbose: core.getInput('verbose') !== 'false',
    artifactName: core.getInput('artifact-name') || 'kernel',
    uploadArtifact: core.getInput('upload-artifact') !== 'false',
    cachixName: core.getInput('cachix-name') || 'huggingface',
    cachixAuthToken: core.getInput('cachix-auth-token') || '',
    nixMaxJobs: core.getInput('nix-max-jobs') || '4',
    nixCores: core.getInput('nix-cores') || '12',
    sandboxMode: core.getInput('sandbox-mode') || 'fallback',
    extraNixConf: core.getInput('extra-nix-conf') || '',
    hfToken: core.getInput('hf-token') || '',
    hfRepo: core.getInput('hf-repo') || '',
    publish: core.getInput('publish') === 'true',
  };
}

async function installNix(
  maxJobs: string,
  cores: string,
  sandboxMode: string,
  extraNixConf: string
): Promise<void> {
  core.info('Installing Nix...');

  // Build sandbox configuration based on mode
  let sandboxConf: string;
  switch (sandboxMode) {
    case 'relaxed':
      sandboxConf = 'sandbox = relaxed';
      break;
    case 'true':
      sandboxConf = 'sandbox = true';
      break;
    case 'false':
      sandboxConf = 'sandbox = false';
      break;
    case 'fallback':
    default:
      sandboxConf = 'sandbox-fallback = false';
      break;
  }

  let extraConf = `max-jobs = ${maxJobs}
cores = ${cores}
${sandboxConf}
experimental-features = nix-command flakes
trusted-users = root runner`;

  // Append any additional configuration
  if (extraNixConf) {
    extraConf += `\n${extraNixConf}`;
  }

  await exec.exec('curl', [
    '--proto',
    '=https',
    '--tlsv1.2',
    '-sSf',
    '-L',
    'https://install.determinate.systems/nix',
    '-o',
    '/tmp/nix-installer.sh',
  ]);

  await exec.exec('sh', [
    '/tmp/nix-installer.sh',
    'install',
    '--no-confirm',
    '--extra-conf',
    extraConf,
  ]);

  // Add Nix to PATH for subsequent steps
  const nixProfilePath = '/nix/var/nix/profiles/default/bin';
  core.addPath(nixProfilePath);
  core.info('Nix installed successfully');
}

async function setupCachix(name: string, authToken: string): Promise<void> {
  if (!name) {
    core.info('Skipping Cachix setup (no cache name provided)');
    return;
  }

  core.info(`Setting up Cachix cache: ${name}`);

  await exec.exec('nix-env', [
    '-iA',
    'cachix',
    '-f',
    'https://cachix.org/api/v1/install',
  ]);

  // Add user profile to PATH where nix-env installs packages
  const nixUserProfilePath = `${process.env.HOME}/.nix-profile/bin`;
  core.addPath(nixUserProfilePath);

  if (authToken) {
    await exec.exec('cachix', ['authtoken', authToken]);
  }

  await exec.exec('cachix', ['use', name]);

  core.info('Cachix configured successfully');
}

async function buildKernel(
  kernelPath: string,
  buildTarget: string,
  nixCommand: 'build' | 'run',
  verbose: boolean,
  hfRepo: string
): Promise<string | null> {
  core.info(`${nixCommand === 'build' ? 'Building' : 'Running'} kernel at ${kernelPath} with target ${buildTarget}`);

  const absoluteKernelPath = path.resolve(kernelPath);

  const args: string[] = [nixCommand];
  if (verbose) {
    args.push('-L');
  }
  args.push(`.#${buildTarget}`);

  // Pass environment variables including HF_REPO for upload targets
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (hfRepo) {
    env.HF_REPO = hfRepo;
    core.info(`Setting HF_REPO=${hfRepo}`);
  }

  await exec.exec('nix', args, {
    cwd: absoluteKernelPath,
    env,
  });

  const resultPath = path.join(absoluteKernelPath, 'result');

  // For 'nix run', the result directory may not exist (e.g., build-and-upload handles upload itself)
  if (!fs.existsSync(resultPath)) {
    if (nixCommand === 'build') {
      throw new Error(`Build result not found at ${resultPath}`);
    }
    core.info('No result directory found (expected for nix run commands that handle their own output)');
    return null;
  }

  core.info('Kernel built successfully');
  return resultPath;
}

async function copyKernel(
  resultPath: string,
  artifactName: string
): Promise<string> {
  const outputPath = `${artifactName}-output`;

  core.info(`Copying kernel from ${resultPath} to ${outputPath}`);

  await exec.exec('cp', ['-rL', resultPath, outputPath]);

  core.info(`Kernel copied to ${outputPath}`);
  return outputPath;
}

async function uploadKernelArtifact(
  kernelOutputPath: string,
  artifactName: string
): Promise<void> {
  core.info(`Uploading artifact: ${artifactName}`);

  const artifactClient = new artifact.DefaultArtifactClient();
  const globber = await glob.create(`${kernelOutputPath}/**/*`);
  const files = await globber.glob();

  await artifactClient.uploadArtifact(artifactName, files, kernelOutputPath);

  core.info('Artifact uploaded successfully');
}

async function publishToHuggingFace(
  kernelOutputPath: string,
  hfRepo: string,
  hfToken: string
): Promise<void> {
  core.info(`Publishing to Hugging Face: ${hfRepo}`);

  await exec.exec('pip', ['install', 'huggingface_hub']);

  const pythonScript = `
from huggingface_hub import HfApi
import os

api = HfApi(token="${hfToken}")
api.upload_folder(
    folder_path="${kernelOutputPath}",
    repo_id="${hfRepo}",
    repo_type="model",
)
print("Successfully published to ${hfRepo}")
`;

  await exec.exec('python', ['-c', pythonScript]);

  core.info('Published to Hugging Face successfully');
}

async function uploadWithKernelsCli(
  kernelPath: string,
  hfRepo: string
): Promise<void> {
  core.info(`Uploading to Kernel Hub: ${hfRepo}`);

  const absoluteKernelPath = path.resolve(kernelPath);

  await exec.exec('nix', ['run', '.#kernels', '--', 'upload', '--repo_id', hfRepo, '.'], {
    cwd: absoluteKernelPath,
  });

  core.info(`Kernel uploaded to https://hf.co/${hfRepo}`);
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs();

    // If hf-repo is set and build-and-upload is requested, use build-and-copy + manual upload
    // because build-and-upload hardcodes the repo to kernels-community
    let buildTarget = inputs.buildTarget;
    const needsManualUpload = inputs.hfRepo && inputs.buildTarget === 'build-and-upload';
    if (needsManualUpload) {
      core.info(`hf-repo is set to ${inputs.hfRepo}, using build-and-copy + manual upload`);
      buildTarget = 'build-and-copy';
    }

    core.startGroup('Install Nix');
    await installNix(
      inputs.nixMaxJobs,
      inputs.nixCores,
      inputs.sandboxMode,
      inputs.extraNixConf
    );
    core.endGroup();

    core.startGroup('Setup Cachix');
    await setupCachix(inputs.cachixName, inputs.cachixAuthToken);
    core.endGroup();

    core.startGroup(inputs.nixCommand === 'build' ? 'Build Kernel' : 'Run Kernel');
    const resultPath = await buildKernel(
      inputs.kernelPath,
      buildTarget,
      inputs.nixCommand,
      inputs.verbose,
      inputs.hfRepo
    );
    core.endGroup();

    // If manual upload is needed, do it now
    if (needsManualUpload) {
      core.startGroup('Upload to Kernel Hub');
      await uploadWithKernelsCli(inputs.kernelPath, inputs.hfRepo);
      core.endGroup();
      core.setOutput('kernel-path', '');
      core.setOutput('artifact-name', inputs.artifactName);
      core.info('Action completed successfully!');
      return;
    }

    // If no result path (e.g., nix run that handles its own output), skip copy/upload/publish
    if (resultPath === null) {
      core.info('No result to copy/upload (nix run command handled output)');
      core.setOutput('kernel-path', '');
      core.setOutput('artifact-name', inputs.artifactName);
      core.info('Action completed successfully!');
      return;
    }

    core.startGroup('Copy Kernel');
    const kernelOutputPath = await copyKernel(resultPath, inputs.artifactName);
    core.setOutput('kernel-path', kernelOutputPath);
    core.setOutput('artifact-name', inputs.artifactName);
    core.endGroup();

    if (inputs.uploadArtifact) {
      core.startGroup('Upload Artifact');
      await uploadKernelArtifact(kernelOutputPath, inputs.artifactName);
      core.endGroup();
    }

    if (inputs.publish && inputs.hfToken && inputs.hfRepo) {
      core.startGroup('Publish to Hugging Face');
      await publishToHuggingFace(
        kernelOutputPath,
        inputs.hfRepo,
        inputs.hfToken
      );
      core.endGroup();
    } else if (inputs.publish) {
      core.warning(
        'Publish requested but hf-token or hf-repo not provided. Skipping publish.'
      );
    }

    core.info('Action completed successfully!');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unexpected error occurred');
    }
  }
}

run();
