const fs = require('fs');
const path = require('path');
const { Arch } = require('builder-util');
const {
  prepareWhisperRuntime
} = require('./prepare-whisper-runtime');

const PROJECT_ROOT =
  path.resolve(__dirname, '..');

async function bundlePreparedWindowsRuntime(
  context,
  architecture
) {
  if (architecture !== 'x64') {
    throw new Error(
      'Static Windows Whisper runtime ' +
      `is only prepared for x64, received ${architecture}.`
    );
  }

  const sourceDirectory = path.join(
    PROJECT_ROOT,
    '.cache',
    'whisper-runtime',
    'win32-x64'
  );

  const executablePath = path.join(
    sourceDirectory,
    'whisper-server.exe'
  );

  const manifestPath = path.join(
    sourceDirectory,
    'runtime.json'
  );

  let manifest;

  try {
    manifest = JSON.parse(
      await fs.promises.readFile(
        manifestPath,
        'utf8'
      )
    );
  } catch {
    throw new Error(
      'Prepared static Windows Whisper runtime ' +
      'is missing. Run `npm run prepare:whisper` ' +
      'before packaging.'
    );
  }

  if (
    manifest.target !== 'win32-x64' ||
    manifest.backend !== 'cpu-static' ||
    manifest.dynamicBackends !== false ||
    !fs.existsSync(executablePath)
  ) {
    throw new Error(
      'The cached Windows Whisper runtime is not ' +
      'the verified cue static CPU runtime. ' +
      'Re-run `npm run prepare:whisper`.'
    );
  }

  const destinationDirectory =
    path.join(
      context.appOutDir,
      'resources',
      'whisper-runtime'
    );

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

  console.log(
    '[cue] Bundled verified static Windows Whisper runtime.'
  );
}

module.exports =
async function afterPack(context) {

  const platform =
    context.packager.platform.nodeName;

  const architecture =
    typeof context.arch === 'number'
      ? Arch[context.arch]
      : context.arch;

  if (!platform || !architecture) {
    throw new Error(
      'electron-builder did not provide a runtime target.'
    );
  }

  if (platform === 'win32') {
    await bundlePreparedWindowsRuntime(
      context,
      architecture
    );

    return;
  }

  // Preserve existing behavior on non-Windows.
  if (!process.env.CUE_BUNDLE_WHISPER) {
    console.log(
      '[cue] Skipping bundled Whisper runtime ' +
      'on this platform.'
    );

    return;
  }

  const outputDirectory =
    path.join(
      context.appOutDir,
      'resources',
      'whisper-runtime'
    );

  await prepareWhisperRuntime({
    platform,
    architecture,
    outputDirectory
  });
};