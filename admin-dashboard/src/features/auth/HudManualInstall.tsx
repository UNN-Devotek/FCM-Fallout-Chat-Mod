import type { CSSProperties } from 'react';

interface Props {
  linkUrl: string;
  bodyStyle: CSSProperties;
  stepStyle: CSSProperties;
  noteStyle: CSSProperties;
}

/** Manual steps for the shared HUD archive, using the current site's relay. */
export default function HudManualInstall({ linkUrl, bodyStyle, stepStyle, noteStyle }: Props) {
  const relayUrl = new URL('/relay', linkUrl);
  relayUrl.protocol = relayUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const codeStyle: CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 'inherit' };
  return (
    <section aria-label="Manual HUD installation" style={{ overflowWrap: 'anywhere' }}>
      <div style={stepStyle}>MANUAL HUD INSTALLATION — NO INSTALLER REQUIRED</div>
      <div style={bodyStyle}>Use this section only for the visible <code>FCMChatWidget</code> HUD.</div>

      <div style={stepStyle}>STEP 1 — PREPARE</div>
      <div style={bodyStyle}>
        Close Fallout 76. Install HUDModLoader and exactly one extender: the latest ZFE or the latest xScal.
        Do not install <code>FCMServerBridge.ba2</code> with the visible HUD.
      </div>

      <div style={stepStyle}>STEP 2 — EXTRACT THE ZIP</div>
      <div style={bodyStyle}>
        Extract the FCM HUD Mod ZIP to a temporary folder outside the Fallout 76 installation,
        such as <code>Downloads/FCM-HUD</code>. Do not extract the entire archive over the game;
        it also contains instructions and examples. Copy only the shared files below into the game:
        <pre style={codeStyle}>{'Data/FCMChatWidget.ba2\nData/FCMChat.ini'}</pre>
        Keep the remaining examples and instructions outside the game folder.
      </div>

      <div style={stepStyle}>STEP 3 — REGISTER WITH HUDMODLOADER</div>
      <div style={bodyStyle}>
        Add <code>FCMChatWidget</code> once to <code>Data/hudmodloader.ini</code>. Preserve existing entries.
      </div>

      <div style={stepStyle}>STEP 4 — REGISTER THE BA2</div>
      <div style={bodyStyle}>
        Add <code>FCMChatWidget.ba2</code> once to <code>sResourceArchive2List</code> in the active{' '}
        <code>Fallout76Custom.ini</code>. Preserve every existing archive. Example:
        <pre style={codeStyle}>{'[Archive]\nsResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2'}</pre>
        Do not create duplicate sections or replace your existing archive list.
      </div>
      <div style={noteStyle}>
        Windows: <code>Documents/My Games/Fallout 76/Fallout76Custom.ini</code>.
        {' '}Steam Proton: inside <code>steamapps/compatdata/1151340/pfx/drive_c/users/steamuser/</code>,
        then <code>Documents/My Games/Fallout 76/Fallout76Custom.ini</code>.
        The <code>Data/</code> files belong in the game installation folder.
      </div>

      <div style={stepStyle}>STEP 5A — xScal ONLY</div>
      <div style={bodyStyle}>
        Back up and open <code>xscal.ini</code> beside <code>Fallout76.exe</code>. Edit the existing
        {' '}<code>[Chat]</code> section to use:
        <pre style={codeStyle}>{`[Chat]\nenabled=true\nrelayEndpoint=${relayUrl.href}`}</pre>
        If the file or section is missing, create it beside <code>Fallout76.exe</code>. Make sure the
        filename is <code>xscal.ini</code>, not <code>xscal.ini.txt</code>. Preserve unrelated settings
        and do not create a second <code>[Chat]</code> section.
      </div>
      <div style={noteStyle}>
        xScal ships with chat disabled. Copying <code>xscal.ini.example</code> does not change your
        active configuration. Do not install the ZFE fragment.
      </div>

      <div style={stepStyle}>STEP 5B — ZFE ONLY</div>
      <div style={bodyStyle}>
        Copy the complete <code>examples/ZFE/FCMChatWidget.ini.example</code> file to:
        <pre style={codeStyle}>Data/ZFE/TextChat/fragments/FCMChatWidget.ini</pre>
        Create the folders if needed and remove <code>.example</code> from the copied filename.
        Copy the entire example. If <code>Data/configuration/zfe.ini</code> contains a{' '}
        <code>[TextChat]</code> section, make sure it uses:
        <pre style={codeStyle}>{`[TextChat]\nEndpoint=${relayUrl.href}`}</pre>
        Otherwise, no <code>zfe.ini</code> edit is needed. Do not create <code>xscal.ini</code> for ZFE.
      </div>

      <div style={stepStyle}>STEP 6 — VERIFY AND LINK</div>
      <div style={bodyStyle}>
        Restart Fallout 76. Press F11 and confirm the FCM menu appears.
        When the widget displays a fresh link code, open{' '}
        <a href={linkUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#C8A840' }}>the account-link page</a>,
        sign in with Steam or Discord, enter the code, and return to the game.
        Codes expire after 10 minutes. Reconnect the widget if you need a new code.
      </div>
    </section>
  );
}
