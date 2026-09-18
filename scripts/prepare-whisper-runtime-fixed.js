#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { prepareWhisperRuntime } = require('./prepare-whisper-runtime');

const WHISPER_CPP_VERSION = '1.9.1';
const WHISPER_CPP_COMMIT = 'f049fff95a089aa9969deb009cdd4892b3e74916';
const WHISPER_REPOSITORY = 'https://github.com/ggml-org/whisper.cpp.git';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_ROOT = path.join(PROJECT_ROOT, '.cache');

const SOURCE_DIRECTORY = path.join(
  CACHE_ROOT,
  'whisper-source',
  `whisper.cpp-${WHISPER_CPP_VERSION}`
);

const BUILD_DIRECTORY = path.join(
  CACHE_ROOT,
  'whisper-build',
  'win32-x64'
);

const DEFAULT_OUTPUT_DIRECTORY = path.join(
  CACHE_ROOT,
  'whisper-runtime',
  'win32-x64'
);

const EXECUTABLE_NAME = 'whisper-server.exe';

const LICENSE_PATH = path.join(
  PROJECT_ROOT,
  'build-resources',
  'whisper.cpp.LICENSE'
);

function readArgument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd || PROJECT_ROOT,
    env: process.env,
    stdio: options.stdio || 'inherit',
    windowsHide: true
  });
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || PROJECT_ROOT,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function ensureCommand(command, friendlyName) {
  const probe = spawnSync(
    command,
    ['--version'],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  );

  if (probe.error || probe.status !== 0) {
    throw new Error(
      `${friendlyName} is required. Install it and retry.`
    );
  }
}

function chooseCMakeGenerator() {
  const help = capture(
    'cmake',
    ['--help']
  );

  const programFilesX86 =
    process.env['ProgramFiles(x86)'] ||
    'C:\\Program Files (x86)';

  const vswherePath = path.join(
    programFilesX86,
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  );

  let installedMajor = null;

  // First choice: ask Visual Studio's official discovery tool
  // which C++ Build Tools installation is actually present.
  if (fs.existsSync(vswherePath)) {
    try {
      const installationVersion =
        capture(
          vswherePath,
          [
            '-latest',
            '-products',
            '*',
            '-requires',
            'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
            '-property',
            'installationVersion'
          ]
        );

      const parsedMajor =
        Number.parseInt(
          installationVersion.split('.')[0],
          10
        );

      if (Number.isInteger(parsedMajor)) {
        installedMajor = parsedMajor;
      }
    } catch {
      // Fall through to filesystem detection.
    }
  }

  // Fallback for standalone Build Tools installations.
  if (!installedMajor) {
    const vs18Directory = path.join(
      programFilesX86,
      'Microsoft Visual Studio',
      '18'
    );

    const vs17Directory = path.join(
      programFilesX86,
      'Microsoft Visual Studio',
      '2022'
    );

    const vs16Directory = path.join(
      programFilesX86,
      'Microsoft Visual Studio',
      '2019'
    );

    if (fs.existsSync(vs18Directory)) {
      installedMajor = 18;
    } else if (fs.existsSync(vs17Directory)) {
      installedMajor = 17;
    } else if (fs.existsSync(vs16Directory)) {
      installedMajor = 16;
    }
  }

  if (
    installedMajor >= 18 &&
    help.includes('Visual Studio 18 2026')
  ) {
    console.log(
      '[cue] Using Visual Studio 18 2026 C++ toolchain.'
    );

    return [
      '-G',
      'Visual Studio 18 2026',
      '-A',
      'x64'
    ];
  }

  if (
    installedMajor >= 17 &&
    help.includes('Visual Studio 17 2022')
  ) {
    console.log(
      '[cue] Using Visual Studio 17 2022 C++ toolchain.'
    );

    return [
      '-G',
      'Visual Studio 17 2022',
      '-A',
      'x64'
    ];
  }

  if (
    installedMajor >= 16 &&
    help.includes('Visual Studio 16 2019')
  ) {
    console.log(
      '[cue] Using Visual Studio 16 2019 C++ toolchain.'
    );

    return [
      '-G',
      'Visual Studio 16 2019',
      '-A',
      'x64'
    ];
  }

  throw new Error(
    'No compatible Visual Studio C++ Build Tools installation was found. ' +
    'Install Visual Studio Build Tools with the "Desktop development with C++" workload.'
  );
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');

  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

async function findFile(rootDirectory, filename) {
  const pending = [rootDirectory];

  while (pending.length) {
    const current = pending.pop();

    const entries = await fs.promises.readdir(
      current,
      { withFileTypes: true }
    );

    for (const entry of entries) {
      const entryPath = path.join(
        current,
        entry.name
      );

      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name === filename
      ) {
        return entryPath;
      }
    }
  }

  throw new Error(
    `Could not find ${filename} under ${rootDirectory}.`
  );
}

async function ensureSourceCheckout() {
  let currentCommit = null;

  try {
    currentCommit = capture(
      'git',
      ['rev-parse', 'HEAD'],
      {
        cwd: SOURCE_DIRECTORY
      }
    );
  } catch {
    // Recreate below.
  }

  if (currentCommit === WHISPER_CPP_COMMIT) {
    return;
  }

  await fs.promises.rm(
    SOURCE_DIRECTORY,
    {
      recursive: true,
      force: true
    }
  );

  await fs.promises.mkdir(
    path.dirname(SOURCE_DIRECTORY),
    {
      recursive: true
    }
  );

  run(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      `v${WHISPER_CPP_VERSION}`,
      WHISPER_REPOSITORY,
      SOURCE_DIRECTORY
    ]
  );

  const verifiedCommit = capture(
    'git',
    ['rev-parse', 'HEAD'],
    {
      cwd: SOURCE_DIRECTORY
    }
  );

  if (verifiedCommit !== WHISPER_CPP_COMMIT) {
    throw new Error(
      'whisper.cpp source mismatch: ' +
      `expected ${WHISPER_CPP_COMMIT}, ` +
      `received ${verifiedCommit}.`
    );
  }
}

async function copyDirectory(
  sourceDirectory,
  destinationDirectory
) {
  await fs.promises.rm(
    destinationDirectory,
    {
      recursive: true,
      force: true
    }
  );

  await fs.promises.mkdir(
    path.dirname(destinationDirectory),
    {
      recursive: true
    }
  );

  await fs.promises.cp(
    sourceDirectory,
    destinationDirectory,
    {
      recursive: true
    }
  );
}

async function buildStaticWindowsRuntime(
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY
) {
  if (
    process.platform !== 'win32' ||
    process.arch !== 'x64'
  ) {
    throw new Error(
      'Static Windows Whisper runtime must be ' +
      `built on win32-x64, not ` +
      `${process.platform}-${process.arch}.`
    );
  }

  ensureCommand('git', 'Git');
  ensureCommand('cmake', 'CMake');

  const generator = chooseCMakeGenerator();

  await ensureSourceCheckout();

  await fs.promises.rm(
    BUILD_DIRECTORY,
    {
      recursive: true,
      force: true
    }
  );

  await fs.promises.mkdir(
    BUILD_DIRECTORY,
    {
      recursive: true
    }
  );

  run(
    'cmake',
    [
      '-S',
      SOURCE_DIRECTORY,

      '-B',
      BUILD_DIRECTORY,

      ...generator,

      '-DCMAKE_BUILD_TYPE=Release',

      // Static MSVC runtime.
      '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',

      // No whisper/ggml DLLs.
      '-DBUILD_SHARED_LIBS=OFF',

      // Critical: disable dynamic CPU backend loading.
      '-DGGML_BACKEND_DL=OFF',
      '-DGGML_CPU_ALL_VARIANTS=OFF',

      // Do not optimize specifically for the build PC.
      '-DGGML_NATIVE=OFF',
      '-DGGML_BMI2=OFF',

      // Keep the runtime self-contained and conservative.
      '-DGGML_BLAS=OFF',
      '-DGGML_OPENMP=OFF',

      // CPU only.
      '-DGGML_CUDA=OFF',
      '-DGGML_VULKAN=OFF',
      '-DGGML_RPC=OFF',

      // No additional native acceleration libraries.
      '-DWHISPER_OPENVINO=OFF',
      '-DWHISPER_SDL2=OFF',

      '-DWHISPER_BUILD_TESTS=OFF',
      '-DWHISPER_BUILD_EXAMPLES=ON',
      '-DWHISPER_BUILD_SERVER=ON'
    ]
  );

  run(
    'cmake',
    [
      '--build',
      BUILD_DIRECTORY,

      '--config',
      'Release',

      '--target',
      'whisper-server',

      '--parallel',
      String(
        Math.max(
          1,
          Math.min(
            os.cpus().length,
            6
          )
        )
      )
    ]
  );

  const builtExecutable = await findFile(
    BUILD_DIRECTORY,
    EXECUTABLE_NAME
  );

  const stagingDirectory =
    await fs.promises.mkdtemp(
      path.join(
        os.tmpdir(),
        'cue-whisper-static-'
      )
    );

  try {
    const stagedExecutable = path.join(
      stagingDirectory,
      EXECUTABLE_NAME
    );

    await fs.promises.copyFile(
      builtExecutable,
      stagedExecutable
    );

    if (fs.existsSync(LICENSE_PATH)) {
      await fs.promises.copyFile(
        LICENSE_PATH,
        path.join(
          stagingDirectory,
          'whisper.cpp.LICENSE'
        )
      );
    }

    // Basic executable smoke test.
    const smoke = spawnSync(
      stagedExecutable,
      ['--help'],
      {
        cwd: stagingDirectory,
        encoding: 'utf8',
        windowsHide: true
      }
    );

    const smokeOutput =
      `${smoke.stdout || ''}\n` +
      `${smoke.stderr || ''}`;

    if (
      smoke.error ||
      smoke.status !== 0 ||
      !smokeOutput.includes('--model')
    ) {
      throw (
        smoke.error ||
        new Error(
          'Static whisper-server smoke test failed ' +
          `(${smoke.status}).\n` +
          smokeOutput.slice(-1500)
        )
      );
    }

    const manifest = {
      name: 'cue-whisper-runtime',
      version: WHISPER_CPP_VERSION,
      sourceCommit: WHISPER_CPP_COMMIT,

      target: 'win32-x64',

      backend: 'cpu-static',
      dynamicBackends: false,
      gpu: false,
      openmp: false,

      executable: EXECUTABLE_NAME,

      executableSha256:
        await sha256(
          stagedExecutable
        ),

      builtAt:
        new Date().toISOString()
    };

    await fs.promises.writeFile(
      path.join(
        stagingDirectory,
        'runtime.json'
      ),
      `${JSON.stringify(
        manifest,
        null,
        2
      )}\n`,
      'utf8'
    );

    await copyDirectory(
      stagingDirectory,
      outputDirectory
    );

  } finally {
    await fs.promises.rm(
      stagingDirectory,
      {
        recursive: true,
        force: true
      }
    );
  }

  return outputDirectory;
}

async function prepareWhisperRuntimeFixed({
  platform = process.platform,
  architecture = process.arch,
  outputDirectory = null
} = {}) {

  if (
    platform === 'win32' &&
    architecture === 'x64'
  ) {
    const cachedDirectory =
      await buildStaticWindowsRuntime();

    if (outputDirectory) {
      await copyDirectory(
        cachedDirectory,
        path.resolve(outputDirectory)
      );

      return path.resolve(
        outputDirectory
      );
    }

    return cachedDirectory;
  }

  // Keep the existing project implementation on macOS/Linux.
  return prepareWhisperRuntime({
    platform,
    architecture,
    outputDirectory
  });
}

async function main() {
  const output =
    readArgument('output');

  const runtimeDirectory =
    await prepareWhisperRuntimeFixed({
      platform:
        readArgument('platform') ||
        process.platform,

      architecture:
        readArgument('arch') ||
        process.arch,

      outputDirectory:
        output
          ? path.resolve(output)
          : null
    });

  process.stdout.write(
    `Prepared Whisper runtime at ${runtimeDirectory}\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      error.stack ||
      error.message
    );

    process.exitCode = 1;
  });
}

module.exports = {
  prepareWhisperRuntimeFixed,
  buildStaticWindowsRuntime
};