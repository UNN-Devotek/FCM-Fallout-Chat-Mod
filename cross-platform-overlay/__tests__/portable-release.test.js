import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(path.join(repo, '.github/workflows/build-windows.yml'), 'utf8');
describe('portable release', () => {
  it('builds portable separately from NSIS with stable portable metadata', () => {
    expect(workflow).toContain('--win nsis --publish never');
    expect(workflow).toContain('--win portable --publish never');
    expect(workflow).not.toContain('--win nsis portable');
    expect(workflow).toContain('-c.extraMetadata.fcmPortable=true');
    expect(workflow).toContain('-c.extraMetadata.fcmChannel=stable');
    expect(workflow).toContain('options: [installer, portable, both]');
  });

  it('packages the portable overlay with only the validated optional bridge', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'fcm-portable-release-'));
    const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const run = args => spawnSync(ps, ['-NoProfile', ...args], { encoding: 'utf8', timeout: 30000 });
    try {
      const bridge = path.join(temp, 'bridge'); mkdirSync(path.join(bridge, 'Data'), { recursive: true });
      const bytes = Buffer.from('test BA2 fixture');
      writeFileSync(path.join(bridge, 'Data/FCMServerBridge.ba2'), bytes);
      writeFileSync(path.join(bridge, 'BUILD.json'), JSON.stringify({ version: '0.2.19', target: 'prod', ba2Sha256: createHash('sha256').update(bytes).digest('hex') }));
      writeFileSync(path.join(bridge, 'EXPORT.json'), JSON.stringify({ environment: 'prod' }));
      for (const name of ['INSTALL.txt', 'FCMServerBridge.hudmodloader.ini', 'Fallout76Custom.ini.example']) writeFileSync(path.join(bridge, name), 'fixture');
      const providerConfigs = {
        'Provider-ZFE/Data/ZFE/TextChat/fragments/FCMServerBridge.ini': '[TextChat]\nEndpoint=wss://falloutchatmod.com/relay\n',
        'Provider-xScal/xscal.ini': '[Chat]\nenabled=true\nrelayEndpoint=wss://falloutchatmod.com/relay\n',
      };
      for (const [relative, content] of Object.entries(providerConfigs)) {
        const file = path.join(bridge, relative); mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      const bridgeZip = path.join(temp, 'bridge.zip');
      const quotedBridge = `'${bridge.replaceAll("'", "''")}/*'`;
      const quotedZip = `'${bridgeZip.replaceAll("'", "''")}'`;
      expect(run(['-Command', `Compress-Archive -Path ${quotedBridge} -DestinationPath ${quotedZip} -Force`]).status).toBe(0);
      const exe = path.join(temp, 'Fallout Chat Mod Portable 1.4.0.exe');
      writeFileSync(exe, Buffer.alloc(1024 * 1024));
      const instructions = path.join(temp, 'INSTALL.txt'); writeFileSync(instructions, 'ZFE INSTALL\nXSCAL INSTALL\n');
      const args = ['-File', path.join(repo, 'Packaging/package-portable.ps1'), '-Version', '1.4.0', '-PortableExe', exe, '-BridgeZip', bridgeZip, '-BridgeInstructions', instructions, '-OutputDir', path.join(temp, 'out')];
      const result = run(args); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
      const folder = path.join(temp, 'out/Fallout Chat Mod Portable 1.4.0');
      expect(existsSync(folder + '.zip')).toBe(true);
      expect(existsSync(path.join(folder, 'README.txt'))).toBe(true);
      expect(existsSync(path.join(folder, 'FCMData'))).toBe(false);
      expect(existsSync(path.join(folder, 'Optional FCM Bridge/INSTALL.txt'))).toBe(true);
      expect(readFileSync(path.join(folder, 'Optional FCM Bridge/INSTALL.txt'), 'utf8')).toContain('XSCAL INSTALL');
      for (const [relative, content] of Object.entries(providerConfigs)) {
        expect(readFileSync(path.join(folder, 'Optional FCM Bridge', relative), 'utf8')).toBe(content);
      }
      expect(run(args).status).not.toBe(0);
      const fallbackArgs = args.filter((_, index) => index !== args.indexOf('-BridgeInstructions') && index !== args.indexOf('-BridgeInstructions') + 1);
      fallbackArgs[fallbackArgs.indexOf('-OutputDir') + 1] = path.join(temp, 'fallback');
      const fallback = run(fallbackArgs); expect(fallback.stderr).toBe(''); expect(fallback.status).toBe(0);
      const fallbackGuide = readFileSync(path.join(temp, 'fallback/Fallout Chat Mod Portable 1.4.0/Optional FCM Bridge/INSTALL.txt'), 'utf8');
      expect(fallbackGuide).toContain('FCM Server Bridge 0.2.19');
      expect(fallbackGuide).toContain('deployed in prod first');
      expect(fallbackGuide).not.toMatch(/\{(?:version|host|target_lower)\}/);
      writeFileSync(path.join(bridge, 'unexpected.dll'), 'must not be included');
      expect(run(['-Command', `Compress-Archive -Path ${quotedBridge} -DestinationPath ${quotedZip} -Force`]).status).toBe(0);
      fallbackArgs[fallbackArgs.indexOf('-OutputDir') + 1] = path.join(temp, 'rejected');
      const rejected = run(fallbackArgs);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain('Unexpected bridge package entry');
      rmSync(path.join(bridge, 'unexpected.dll'));
      writeFileSync(path.join(bridge, 'BUILD.json'), JSON.stringify({ version: 'invalid', target: 'prod', ba2Sha256: createHash('sha256').update(bytes).digest('hex') }));
      expect(run(['-Command', `Compress-Archive -Path ${quotedBridge} -DestinationPath ${quotedZip} -Force`]).status).toBe(0);
      fallbackArgs[fallbackArgs.indexOf('-OutputDir') + 1] = path.join(temp, 'invalid-version');
      const invalidVersion = run(fallbackArgs);
      expect(invalidVersion.status).not.toBe(0);
      expect(invalidVersion.stderr).toContain('Bridge manifest must contain a semantic version');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 60000);
});
