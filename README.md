# publish-to-the-kernel-hub

A GitHub Action to build kernels using Nix and publish them to the Hugging Face Kernel Hub.

## Important: Bring Your Own Runner (BYOR)

> [!WARNING]
> This action requires a **self-hosted runner** with sufficient resources for most use cases.

When building kernels, Nix vendors all dependencies including PyTorch and CUDA libraries. This pulls in approximately **30GB+ of data**, which exceeds the disk space available on GitHub's default runners. Additionally, the build process is memory-intensive and will likely OOM on default runners.

**Recommended runner specifications:**
- Disk space: 100GB+ free
- RAM: 32GB+ recommended
- CPU: Multi-core for reasonable build times

**Workaround for default runners:** If you must use GitHub's default runners, you can limit your build to a single Torch/CUDA version in your `flake.nix`. However, this means you won't be able to build the full compatibility matrix, which defeats the purpose of multi-version support.

```yaml
jobs:
  build:
    # Use a self-hosted runner with adequate resources
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: huggingface/publish-to-the-kernel-hub@main
        # ...
```

## Usage

### Basic Usage

For a repository with a single kernel at the root:

```yaml
name: Build and Publish Kernel
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: self-hosted  # See BYOR warning above
    steps:
      - uses: actions/checkout@v4
      - uses: huggingface/publish-to-the-kernel-hub@main
        with:
          hf-token: ${{ secrets.HF_TOKEN }}
          hf-repo: "your-username/your-kernel"
          publish: "true"
```

### With Cachix Caching

```yaml
- uses: huggingface/publish-to-the-kernel-hub@main
  with:
    cachix-name: "your-cache"
    cachix-auth-token: ${{ secrets.CACHIX_AUTH_TOKEN }}
    hf-token: ${{ secrets.HF_TOKEN }}
    hf-repo: "your-username/your-kernel"
    publish: "true"
```

### Custom Build Target

```yaml
- uses: huggingface/publish-to-the-kernel-hub@main
  with:
    build-target: "redistributable.torch29-cxx11-cu126-x86_64-linux"
    hf-token: ${{ secrets.HF_TOKEN }}
    hf-repo: "your-username/your-kernel"
    publish: "true"
```

### Build Only (No Publish)

```yaml
- uses: huggingface/publish-to-the-kernel-hub@main
  with:
    artifact-name: "my-kernel"
    upload-artifact: "true"
    publish: "false"
```

## Inputs

| Input               | Description                         | Required | Default                                            |
| ------------------- | ----------------------------------- | -------- | -------------------------------------------------- |
| `kernel-path`       | Path to the kernel directory        | No       | `.`                                                |
| `build-target`      | Nix build target                    | No       | `redistributable.torch29-cxx11-cu126-x86_64-linux` |
| `artifact-name`     | Name for the uploaded artifact      | No       | `kernel`                                           |
| `upload-artifact`   | Upload built kernel as artifact     | No       | `true`                                             |
| `cachix-name`       | Cachix cache name                   | No       | `""`                                               |
| `cachix-auth-token` | Cachix authentication token         | No       | `""`                                               |
| `nix-max-jobs`      | Max parallel Nix build jobs         | No       | `4`                                                |
| `nix-cores`         | Cores per Nix build job             | No       | `12`                                               |
| `hf-token`          | Hugging Face token                  | No       | `""`                                               |
| `hf-repo`           | HF repository (e.g., `user/kernel`) | No       | `""`                                               |
| `publish`           | Publish to Hugging Face             | No       | `false`                                            |

## Outputs

| Output          | Description                   |
| --------------- | ----------------------------- |
| `kernel-path`   | Path to the built kernel      |
| `artifact-name` | Name of the uploaded artifact |

## Requirements

Your repository should contain:
- A valid Nix flake (`flake.nix`) at the kernel path
- The flake should expose redistributable outputs

## Example Repository Structure

```
your-kernel-repo/
├── flake.nix
├── flake.lock
├── src/
│   └── kernel.cu
└── .github/
    └── workflows/
        └── build.yml
```

## Development

```bash
# Install dependencies
npm install

# Build the action
npm run build
```
