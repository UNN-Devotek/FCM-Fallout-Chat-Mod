/**
 * Remotion Root — registers all marketing compositions.
 */

import { Composition } from 'remotion';
import { Header } from './Header';
import { WikiPageStill } from './WikiPageStill';
import { AutocompleteStill } from './AutocompleteStill';
import { ChatFeedStill } from './ChatFeedStill';
import { CoverImage } from './CoverImage';
import { WikiFlowGif } from './WikiFlowVideo';
import { CommandsGif } from './CommandsGif';
import { PartyGif } from './PartyGif';
import { InfestStill } from './InfestStill';
import { InfestGif } from './InfestGif';
import { ChatFeedGif } from './ChatFeedGif';

// 30 fps throughout
const FPS = 30;

export function Root() {
  return (
    <>
      {/* ── Stills ── */}

      <Composition
        id="Header"
        component={Header}
        width={1300}
        height={372}
        fps={FPS}
        durationInFrames={1}
        defaultProps={{}}
      />

      <Composition
        id="WikiPageStill"
        component={WikiPageStill}
        width={480}
        height={690}
        fps={FPS}
        durationInFrames={1}
        defaultProps={{}}
      />

      <Composition
        id="AutocompleteStill"
        component={AutocompleteStill}
        width={480}
        height={530}
        fps={FPS}
        durationInFrames={1}
        defaultProps={{}}
      />

      <Composition
        id="ChatFeedStill"
        component={ChatFeedStill}
        width={480}
        height={530}
        fps={FPS}
        durationInFrames={1}
        defaultProps={{}}
      />

      <Composition
        id="CoverImage"
        component={CoverImage}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={1}
        defaultProps={{}}
      />

      {/* ── Videos / GIFs ── */}

      {/* 14 s at 30 fps = 430 frames */}
      <Composition
        id="WikiFlowGif"
        component={WikiFlowGif}
        width={480}
        height={610}
        fps={FPS}
        durationInFrames={430}
        defaultProps={{}}
      />

      {/* 18 s loop × 2 = 1080 frames at 30 fps */}
      <Composition
        id="CommandsGif"
        component={CommandsGif}
        width={480}
        height={490}
        fps={FPS}
        durationInFrames={1080}
        defaultProps={{}}
      />

      {/* 8 s at 30 fps = 240 frames */}
      <Composition
        id="PartyGif"
        component={PartyGif}
        width={480}
        height={490}
        fps={FPS}
        durationInFrames={240}
        defaultProps={{}}
      />

      {/* ── Infest channel ── */}

      <Composition
        id="InfestStill"
        component={InfestStill}
        width={480}
        height={430}
        fps={FPS}
        durationInFrames={1}
        defaultProps={{}}
      />

      {/* 9 s at 30 fps = 270 frames */}
      <Composition
        id="InfestGif"
        component={InfestGif}
        width={480}
        height={430}
        fps={FPS}
        durationInFrames={270}
        defaultProps={{}}
      />

      {/* ── Chat feed ── */}

      {/* 9 s at 30 fps = 270 frames */}
      <Composition
        id="ChatFeedGif"
        component={ChatFeedGif}
        width={480}
        height={490}
        fps={FPS}
        durationInFrames={270}
        defaultProps={{}}
      />
    </>
  );
}
