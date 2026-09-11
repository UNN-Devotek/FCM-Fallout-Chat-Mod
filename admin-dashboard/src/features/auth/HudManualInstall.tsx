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
      <div style={bodyStyle}>The included xScal setup helper is optional. You can complete every step below by hand.</div>

      <div style={stepStyle}>STEP 1 — PREPARE</div>
      <div style={bodyStyle}>
        Exit Fallout 76 completely. Install HUDModLoader and either ZFE with chat.v1 support or xScal
        with chatInterface support, following their authors’ instructions. Choose one extender;
        the shared FCMChatWidget automatically detects it. The desktop overlay is not required for HUD chat.
      </div>

      <div style={stepStyle}>STEP 2 — EXTRACT THE ZIP</div>
      <div style={bodyStyle}>
        Extract the FCM HUD Mod ZIP into the game installation folder containing <code>Fallout76.exe</code>,
        preserving the archive’s folder structure. The shared files belong at:
        <pre style={codeStyle}>{'Data/FCMChatWidget.ba2\nData/FCMChat.ini'}</pre>
        The ZIP also includes <code>FCMChatWidget.hudmodloader.ini</code>, <code>Fallout76Custom.ini.example</code>,
        {' '}<code>xscal.ini.example</code>, <code>examples/ZFE/FCMChatWidget.ini.example</code>,
        {' '}the optional xScal helpers, and <code>INSTALL.txt</code>.
      </div>

      <div style={stepStyle}>STEP 3 — REGISTER WITH HUDMODLOADER</div>
      <div style={bodyStyle}>
        Back up and open <code>Data/hudmodloader.ini</code>. Append <code>FCMChatWidget</code> on its own
        line exactly once. Preserve every existing widget entry; do not replace the file with the snippet.
      </div>

      <div style={stepStyle}>STEP 4 — REGISTER THE BA2</div>
      <div style={bodyStyle}>
        Back up <code>Fallout76Custom.ini</code>. In its existing <code>[Archive]</code> section, append
        {' '}<code>FCMChatWidget.ba2</code> to the comma-separated <code>sResourceArchive2List</code> value.
        Preserve other archives, including HUDModLoader. A minimal example is:
        <pre style={codeStyle}>{'[Archive]\nsResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2'}</pre>
        Add the section or key only if missing. Do not create duplicate sections or replace your existing archive list.
      </div>
      <div style={noteStyle}>
        Windows: <code>Documents/My Games/Fallout 76/Fallout76Custom.ini</code>.
        {' '}Steam Proton: inside <code>steamapps/compatdata/1151340/pfx/drive_c/users/steamuser/</code>,
        then <code>Documents/My Games/Fallout 76/Fallout76Custom.ini</code>.
        The <code>Data/</code> files belong in the game installation folder.
      </div>

      <div style={stepStyle}>STEP 5 — CONFIGURE YOUR EXTENDER</div>
      <div style={bodyStyle}>Follow the section for your installed extender.</div>
      <div style={stepStyle}>xScal — MANUAL CONFIGURATION</div>
      <div style={bodyStyle}>
        Back up and open <code>xscal.ini</code> beside <code>Fallout76.exe</code>. Edit the existing
        {' '}<code>[Chat]</code> section to use:
        <pre style={codeStyle}>{`[Chat]\nenabled=true\nrelayEndpoint=${relayUrl.href}`}</pre>
        Change <code>enabled=false</code> to <code>enabled=true</code> and replace the relay endpoint.
        If the section is missing, add it once. If the file is missing, create a plain-text
        {' '}<code>xscal.ini</code> beside the game executable—not <code>xscal.ini.txt</code>.
        Preserve unrelated settings and avoid duplicate sections or keys.
      </div>
      <div style={noteStyle}>
        New users must apply these settings too: xScal ships with chat disabled by default.
        Extracting <code>xscal.ini.example</code> alone does not enable chat.
        xScal does not use the ZFE fragment; do not create ZFE folders for this setup.
        On Windows, the optional <code>Enable-xScal-Chat.cmd</code> helper backs up and updates the existing
        configuration instead. Restart Fallout 76 after changing extender settings.
      </div>

      <div style={stepStyle}>ZFE — MANUAL CONFIGURATION</div>
      <div style={bodyStyle}>
        Copy the complete <code>examples/ZFE/FCMChatWidget.ini.example</code> file to:
        <pre style={codeStyle}>Data/ZFE/TextChat/fragments/FCMChatWidget.ini</pre>
        Create the folders if needed and remove the <code>.example</code> suffix.
        Back up any existing fragment and compare its settings before replacing it.
        The example contains <code>{`Endpoint=${relayUrl.href}`}</code>; copy the entire example,
        not just that line. Keep its <code>OpenChatKey</code> aligned with <code>openKey</code> in
        {' '}<code>Data/FCMChat.ini</code> and any override in <code>Data/configuration/zfe.ini</code>.
        <strong>Important:</strong> ZFE applies <code>Data/configuration/zfe.ini</code> after the
        fragment, so its <code>[TextChat]</code> values override the fragment. Check that file even
        when the fragment contains the correct endpoint. If you use a global override, it must be:
        <pre style={codeStyle}>{`[TextChat]\nEndpoint=${relayUrl.href}`}</pre>
        Replace any stale endpoint, preserve unrelated settings, and do not duplicate the section or
        key. If no override is needed, leave the endpoint out of <code>zfe.ini</code> and use the
        packaged fragment. Do not put the relay endpoint in <code>Data/FCMChat.ini</code>.
        ZFE does not need <code>xscal.ini</code>. Restart Fallout 76 after configuration.
      </div>

      <div style={stepStyle}>STEP 6 — VERIFY AND LINK</div>
      <div style={bodyStyle}>
        Start Fallout 76, press F11 to open HUDModLoader, and confirm the FCM menu is present.
        When the widget displays a fresh link code, open{' '}
        <a href={linkUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#C8A840' }}>the account-link page</a>,
        sign in with Steam or Discord, enter the code, and return to the game.
        Steam sign-in does not require Discord. If you leave your name blank, your Steam display name
        is used; you can link Discord later from your profile.
        Codes expire after 10 minutes; reconnect the widget to request a new one.
      </div>
    </section>
  );
}
