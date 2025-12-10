import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as artifact from '@actions/artifact';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as path from 'path';

interface ActionInputs {
  kernelPath: string;
  buildTarget: string;
  artifactName: string;
  uploadArtifact: boolean;
  cachixName: string;
  cachixAuthToken: string;
  nixMaxJobs: string;
  nixCores: string;
  hfToken: string;
  hfRepo: string;
  publish: boolean;
}

function getInputs(): ActionInputs {
  return {
    kernelPath: core.getInput('kernel-path') || '.',
    buildTarget:
      core.getInput('build-target') ||
      'redistributable.torch29-cxx11-cu126-x86_64-linux',
    artifactName: core.getInput('artifact-name') || 'kernel',
    uploadArtifact: core.getInput('upload-artifact') !== 'false',
    cachixName: core.getInput('cachix-name') || 'huggingface',
    cachixAuthToken: core.getInput('cachix-auth-token') || '',
    nixMaxJobs: core.getInput('nix-max-jobs') || '4',
    nixCores: core.getInput('nix-cores') || '12',
    hfToken: core.getInput('hf-token') || '',
    hfRepo: core.getInput('hf-repo') || '',
    publish: core.getInput('publish') === 'true',
  };
}

async function installNix(maxJobs: string, cores: string): Promise<void> {
  core.info('Installing Nix...');

  const extraConf = `max-jobs = ${maxJobs}
cores = ${cores}
sandbox-fallback = false
experimental-features = nix-command flakes`;

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

  if (authToken) {
    await exec.exec('cachix', ['authtoken', authToken]);
  }

  await exec.exec('cachix', ['use', name]);

  core.info('Cachix configured successfully');
}

async function buildKernel(
  kernelPath: string,
  buildTarget: string
): Promise<string> {
  core.info(`Building kernel at ${kernelPath} with target ${buildTarget}`);

  const absoluteKernelPath = path.resolve(kernelPath);

  await exec.exec('nix', ['build', `.#${buildTarget}`], {
    cwd: absoluteKernelPath,
  });

  const resultPath = path.join(absoluteKernelPath, 'result');

  if (!fs.existsSync(resultPath)) {
    throw new Error(`Build result not found at ${resultPath}`);
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

async function run(): Promise<void> {
  try {
    const inputs = getInputs();

    core.startGroup('Install Nix');
    await installNix(inputs.nixMaxJobs, inputs.nixCores);
    core.endGroup();

    core.startGroup('Setup Cachix');
    await setupCachix(inputs.cachixName, inputs.cachixAuthToken);
    core.endGroup();

    core.startGroup('Build Kernel');
    const resultPath = await buildKernel(inputs.kernelPath, inputs.buildTarget);
    core.endGroup();

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
