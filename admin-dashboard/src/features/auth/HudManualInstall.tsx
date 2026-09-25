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

      <div style={stepStyle}>STEP 2 — CHOOSE A PROVIDER FOLDER</div>
      <div style={bodyStyle}>
        Extract the FCM HUD Mod ZIP to a temporary folder outside the Fallout 76 installation,
        such as <code>Downloads/FCM-HUD</code>. Open only <code>ZFE (Install for ZFE only)/</code> or <code>xScal (Install for xScal only)/</code>
        {' '}and read its <code>INSTALL.txt</code>; the ZIP root <code>README.txt</code> has reference details. Open its <code>Data (drag the contents into data folder)/</code> folder and drag the contents into the game&apos;s <code>Data/</code> folder. Skip existing INIs, and do not copy the labeled folder itself.
        On a manual update, replace only <code>Data/FCMChatWidget.ba2</code>. Keep edited INIs;
        compare packaged defaults for any new settings. Do not copy both provider folders.
      </div>

      <div style={noteStyle}>
        Quick Configuration 2 or NukaMods: extract the ZIP and import only your chosen
        {' '}<code>ZFE (Install for ZFE only)/Data (drag the contents into data folder)/FCMChatWidget.ba2</code> or <code>xScal (Install for xScal only)/Data (drag the contents into data folder)/FCMChatWidget.ba2</code>
        {' '}as a BA2 mod. Do not import the combined ZIP. Let the manager deploy the BA2 and
        maintain its archive-list entry. Copy only missing INIs or the ZFE fragment from the
        chosen folder; keep edited files. Complete the HUDModLoader and provider steps below.
        Verify one deployed BA2 and one archive-list entry.
      </div>
      <div style={stepStyle}>STEP 3 — REGISTER WITH HUDMODLOADER</div>
      <div style={bodyStyle}>
        If the game&apos;s <code>Data/hudmodloader.ini</code> is missing, copy the chosen folder&apos;s
        {' '}file there; it includes HUDModLoader&apos;s defaults and FCMChatWidget. Otherwise add
        {' '}<code>FCMChatWidget</code> once and preserve all existing entries.
      </div>

      <div style={stepStyle}>STEP 4 — REGISTER THE BA2</div>
      <div style={bodyStyle}>
        For a manual install, add <code>FCMChatWidget.ba2</code> once to <code>sResourceArchive2List</code> in the active{' '}
        <code>Fallout76Custom.ini</code>. Preserve every existing archive. Example:
        <pre style={codeStyle}>{'[Archive]\nsResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2'}</pre>
        The chosen folder&apos;s root <code>Fallout76Custom.ini</code> is a merge template. Do not create duplicate sections or replace your existing archive list.
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
        xScal ships with chat disabled. The packaged <code>xScal (Install for xScal only)/xscal.ini</code> is a merge template and does not change your
        active configuration. Do not install the ZFE fragment.
      </div>

      <div style={stepStyle}>STEP 5B — ZFE ONLY</div>
      <div style={bodyStyle}>
        The selected <code>ZFE (Install for ZFE only)/Data (drag the contents into data folder)/</code> folder already contains the complete fragment for this game path:
        <pre style={codeStyle}>Data/ZFE/TextChat/fragments/FCMChatWidget.ini</pre>
        Copy only a missing fragment to that path. Preserve an existing edited fragment on
        updates. If <code>Data/configuration/zfe.ini</code> contains a{' '}
        <code>[TextChat]</code> section, make sure it uses:
        <pre style={codeStyle}>{`[TextChat]\nEndpoint=${relayUrl.href}`}</pre>
        No separate <code>zfe.ini</code> is included or required. Do not create <code>xscal.ini</code> for ZFE.
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
