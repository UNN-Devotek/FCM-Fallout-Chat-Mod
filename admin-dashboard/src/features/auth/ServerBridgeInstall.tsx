import type { CSSProperties } from 'react';

interface Props {
  bodyStyle: CSSProperties;
  stepStyle: CSSProperties;
  noteStyle: CSSProperties;
}

/** Optional desktop Server-chat bridge instructions shared by public install surfaces. */
export default function ServerBridgeInstall({ bodyStyle, stepStyle, noteStyle }: Props) {
  return (
    <section aria-label="Optional Server Bridge installation" style={{ overflowWrap: 'anywhere' }}>
      <div style={{ ...stepStyle, marginTop: '28px' }}>2. CURRENT-SERVER CHAT — OPTIONAL</div>
      <div style={bodyStyle}>
        Install this only if you want the desktop overlay&apos;s Server tab. It is inside every overlay
        ZIP under <code>Optional FCM Bridge</code> and is never installed automatically.
      </div>
      <div style={noteStyle}>
        Choose one: <code>FCMServerBridge.ba2</code> for the desktop overlay, or{' '}
        <code>FCMChatWidget.ba2</code> for visible in-game chat. Never install both.
      </div>

      <div style={stepStyle}>SERVER BRIDGE — SHARED STEPS</div>
      <div style={bodyStyle}>
        1. Close Fallout 76. Install HUDModLoader and either ZFE or xScal 0.2.17 or newer.<br />
        2. Extract the overlay ZIP outside the game folder and open <code>Optional FCM Bridge</code>.<br />
        3. Copy <code>Data/FCMServerBridge.ba2</code> into the game&apos;s <code>Data</code> folder.<br />
        4. Add <code>FCMServerBridge</code> once to <code>Data/hudmodloader.ini</code>. Preserve existing entries.<br />
        5. Add <code>FCMServerBridge.ba2</code> once to <code>sResourceArchive2List</code> in the active{' '}
        <code>Fallout76Custom.ini</code>. Preserve every existing archive.<br />
        6. Start Fallout Chat Mod, sign in, launch Fallout 76, and join a public world. The Server
        tab appears automatically.
      </div>

      <div style={stepStyle}>IF YOU USE xScal</div>
      <div style={bodyStyle}>
        Use xScal 0.2.17 or newer. <strong>Do not edit <code>xscal.ini</code>.</strong> The{' '}
        <code>[Chat]</code> settings are for the visible in-game HUD, not the Server Bridge.
      </div>

      <div style={stepStyle}>IF YOU USE ZFE</div>
      <div style={bodyStyle}>
        Do not add a TextChat fragment, <code>zfe.ini</code>, <code>falloutchatmod.ini</code>, or a
        relay endpoint. A ZFE installation containing only its DLL is normal.
      </div>
    </section>
  );
}
