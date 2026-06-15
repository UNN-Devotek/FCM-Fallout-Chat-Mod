import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setCodec('h264');
Config.setConcurrency(2);

// WSL2 /mnt/d doesn't fire inotify events — use polling so edits hot-reload.
Config.overrideWebpackConfig((config) => ({
  ...config,
  watchOptions: {
    ...config.watchOptions,
    poll: 1000,
    aggregateTimeout: 300,
  },
}));
