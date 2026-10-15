const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { writerRows, compare, sourceOwners, inventory } = require('./setup/runtime-writer-inventory.cjs');
const file = 'backend/src/services/deviceAuthService.ts';
const ledgerFor = source => ({ rows: writerRows(file, source).map(row => ({ ...row, disposition: 'optional', reason: 'Last-seen telemetry only', caller: 'verifySignedRequest' })) });
const source = `async function verifySignedRequest() { await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } }); }`;
test('line, whitespace and comment changes preserve stable writer identity and semantic policy', () => {
  expect(compare(writerRows(file, '\n\n// shifted source\n' + source.replace('await prisma', 'await   prisma')), ledgerFor(source))).toEqual([]);
});
test('an optional last-seen update changed into an authority mutation forces explicit reclassification', () => {
  const changed = source.replace('lastSeenAt', 'revokedAt');
  expect(writerRows(file, source)[0].writerId).toBe(writerRows(file, changed)[0].writerId);
  expect(compare(writerRows(file, changed), ledgerFor(source))).toContainEqual(expect.objectContaining({ reason: 'semantic-shape-changed' }));
});
test('a Redis cache key changed into session authority forces review with the same call count', () => {
  const before = `async function save() { const key = 'display:cache'; await redis.set(key, value); }`;
  const after = before.replace('display:cache', 'session:authority');
  expect(compare(writerRows(file, after), ledgerFor(before))).toContainEqual(expect.objectContaining({ reason: 'semantic-shape-changed' }));
});
test('adding a swallowing catch inside a required owner cannot silently retain the old covered classification', () => {
  const before = `async function save() { await runtime.required('authority', async () => { await prisma.device.update({ data: { revokedAt: new Date() } }); }); }`;
  const after = before.replace('}); });', '}).catch(() => {}); });');
  const ledger = { rows: writerRows(file, before).map(row => ({ ...row, disposition: 'required', reason: 'Unknown revocation must propagate to its required owner' })) };
  expect(compare(writerRows(file, after), ledger)).toContainEqual(expect.objectContaining({ reason: 'semantic-shape-changed' }));
});
test('removing an actual required ancestor fails even if the caller retained an old covered ledger label', () => {
  const before = `async function save() { await runRequiredEffect('authority', {}, () => prisma.device.update({ data: { revokedAt: new Date() } })); }`;
  const after = `async function save() { await prisma.device.update({ data: { revokedAt: new Date() } }); }`;
  const ledger = { rows: writerRows(file, before).map(row => ({ ...row, disposition: 'required' })) };
  expect(compare(writerRows(file, after), ledger)).toContainEqual(expect.objectContaining({ reason: 'required-disposition-boundary-missing' }));
});
test('alias OAuth writers and Redis publication commands participate in the inventory', () => {
  expect(writerRows('backend/src/services/mcpAuthorizationService.ts', `class OAuth { async issue() { await this.db.mcpOAuthCode.create({data}); await db.mcpOAuthGrant.updateMany({where,data}); } }`)).toHaveLength(2);
  expect(writerRows(file, `async function publish() { await redis.lPush(key, payload); await redis.lTrim(key, 0, 99); await redis.publish(channel, payload); }`)).toHaveLength(3);
});

test.each(['runRequiredLookup', 'runRequiredPublicationPrerequisite'])('an aliased %s preserves the actual Redis publication writer', helper => {
  const argumentsBeforeFactory = helper === 'runRequiredLookup' ? "'publication', 'client'," : "'client',";
  const wrapped = `import { ${helper} as prepare } from '../../lib/requiredEffects';
    import { getRedisClient } from '../../config/redis';
    async function publish() {
      const outbound = await prepare(${argumentsBeforeFactory} () => getRedisClient());
      await outbound.publish(channel, payload);
    }`;
  const direct = wrapped.replace(`prepare(${argumentsBeforeFactory} () => getRedisClient())`, 'getRedisClient()');
  const rows = writerRows(file, wrapped);
  expect(rows).toHaveLength(1);
  expect(rows[0].family).toBe('redis-sdk-command-candidate');
  expect(rows[0].sdkReference).toBe('@redis:getRedisClient().publish');
  expect(rows[0].writerId).toBe(writerRows(file, direct)[0].writerId);
});

test('a string tracedOwner never substitutes for a current required disposition boundary', () => {
  const rows = writerRows(file, source), ledger = { rows: rows.map(row => ({ ...row, disposition: 'required', tracedOwner: 'previously-reviewed' })) };
  expect(compare(rows, ledger)).toContainEqual(expect.objectContaining({ reason: 'required-disposition-boundary-missing' }));
});

test.each(['removed', 'swallowed', 'work-accounting-only'])('delegated caller proof fails when its external required owner is %s', mode => {
  const callerFile = 'backend/src/services/authorityOwner.ts';
  const before = `async function revoke() { return runtime.required('authority', async () => { await primaryWriter(); }); }`;
  const originalOwner = sourceOwners(callerFile, before).find(owner => owner.identity.owner === 'revoke');
  const rows = writerRows(file, source), ledger = { rows: rows.map(row => ({ ...row, disposition: 'delegated', ownerProofs: [{
    identity: originalOwner.identity, fingerprint: originalOwner.fingerprint, contract: 'retained-required-disposition', requiredCalls: ['runtime.required'],
  }] })) };
  expect(compare(rows, ledger, sourceOwners(callerFile, before))).toEqual([]);
  const after = mode === 'removed' ? '' : mode === 'swallowed' ? before.replace('await primaryWriter()', 'await primaryWriter().catch(() => {})') : before.replace('runtime.required', 'runtime.run');
  expect(compare(rows, ledger, sourceOwners(callerFile, after))).toContainEqual(expect.objectContaining({ reason: 'delegated-owner-proof-invalid' }));
});

test('new startup/script mutations remain in the complete inventory and force classification', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-inventory-script-'));
  try {
    const scripts = path.join(directory, 'backend/src/scripts'); fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'postPush.ts'), `async function apply() { await client.$executeRawUnsafe('TRUNCATE fixture'); }`);
    const rows = inventory(directory); expect(rows).toHaveLength(1);
    expect(rows[0].identity.file).toBe('backend/src/scripts/postPush.ts');
    expect(compare(rows, { rows: [] })).toContainEqual(expect.objectContaining({ reason: 'unclassified-writer' }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('scoped Discord effects include actual roles, messages, voice and commands while ignoring local builder/cache methods', () => {
  const rows = writerRows('backend/src/services/voiceService.ts', `async function publish() {
    await member.roles.add(roleId); await (channel as TextChannel).send(payload); await vc.setName(name);
    await client.application?.commands.create(command); panels.delete(id); builder.setName('label');
  }`);
  expect(rows).toHaveLength(4); expect(rows.every(row => row.family === 'discord-sdk-mutation')).toBe(true);
});

const repositoryRoot = path.resolve(__dirname, '../..');
const actualLedger = () => JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'backend/runtime-writer-classification.json'), 'utf8'));
function repositoryOwners(ledger) {
  const files = new Set(ledger.rows.map(row => row.identity.file));
  for (const binding of ledger.sourceBindings) files.add(binding.identity.file);
  for (const row of ledger.rows) for (const proof of row.ownerProofs || []) files.add(proof.identity.file);
  return [...files].flatMap(file => sourceOwners(file, fs.readFileSync(path.join(repositoryRoot, file), 'utf8')));
}
test('the required backend CI compares every actual application/startup/script writer and reviewed shared funnel against the durable ledger', () => {
  const ledger = actualLedger(), owners = repositoryOwners(ledger);
  expect(ledger.rows.length).toBeGreaterThan(600);
  expect(ledger.rows.every(row => ['required', 'delegated', 'optional'].includes(row.disposition))).toBe(true);
  expect(compare(inventory(repositoryRoot), ledger, owners)).toEqual([]);
  expect(require('./setup/runtime-writer-inventory.cjs').compareProofBindings(repositoryRoot, ledger, owners)).toEqual([]);
}, 20000);

test('changing the actual optional token last-used field into revocation fails the actual repository policy', () => {
  const ledger = actualLedger(), relative = 'backend/src/services/mcpTokenService.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace('lastUsedAt: new Date()', 'revokedAt: new Date()');
  expect(changed).not.toBe(before);
  const rows = inventory(repositoryRoot).filter(row => row.identity.file !== relative).concat(writerRows(relative, changed));
  const optional = ledger.rows.find(row => row.identity.file === relative && row.disposition === 'optional');
  expect(compare(rows, ledger, repositoryOwners(ledger))).toContainEqual({ writerId: optional.writerId, reason: 'semantic-shape-changed' });
}, 20000);

test('altering the actual shared GitHub REST method cannot keep an old delegated caller proof', () => {
  const ledger = actualLedger(), relative = 'backend/src/services/githubService.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace('    method,', "    method: 'GET',");
  expect(changed).not.toBe(before);
  const owners = repositoryOwners(ledger).filter(owner => owner.identity.file !== relative).concat(sourceOwners(relative, changed));
  expect(require('./setup/runtime-writer-inventory.cjs').compareProofBindings(repositoryRoot, ledger, owners))
    .toContainEqual({ identity: { file: relative, owner: '<module>' }, reason: 'shared-source-proof-changed' });
});

test('a startup shell that swallows required compatibility-patch failure fails the actual script proof', () => {
  const ledger = actualLedger(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-startup-policy-'));
  try {
    fs.mkdirSync(path.join(directory, 'backend'));
    for (const binding of ledger.scriptBindings) {
      let source = fs.readFileSync(path.join(repositoryRoot, binding.file), 'utf8');
      if (binding.file.endsWith('baseline-migrations.sh')) source = source.replace('node dist/scripts/applyPostPushPatches.js', 'node dist/scripts/applyPostPushPatches.js || true');
      fs.writeFileSync(path.join(directory, binding.file), source);
    }
    expect(require('./setup/runtime-writer-inventory.cjs').compareProofBindings(directory, ledger, repositoryOwners(ledger)))
      .toContainEqual({ file: 'backend/baseline-migrations.sh', reason: 'startup-script-proof-changed' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('inline awaited Redis authority, scoped REST and SQL aliases participate in the current inventory', () => {
  expect(writerRows(file, `async function save() { await (await getRedisClient()).set(key, value); }`)).toHaveLength(1);
  expect(writerRows('backend/src/services/githubService.ts', `async function rest(method) { await fetch(url, {method, body}); }`)).toHaveLength(1);
  expect(writerRows('backend/src/jobs/onlineSnapshotJob.ts', `async function run() { await runQuery('INSERT INTO online_snapshots VALUES ($1)', [count]); }`)).toHaveLength(1);
});

test('the actual nested cosmetic role writer and its semantic reversal cannot evade repository policy', () => {
  const ledger = actualLedger(), relative = 'backend/src/services/cosmetics/discordRoleSyncService.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const detected = writerRows(relative, before);
  expect(detected.filter(row => row.family === 'discord-sdk-mutation')).toHaveLength(2);
  const changed = before.replace('member.roles.add(plan.addRoleIds', 'member.roles.remove(plan.addRoleIds');
  expect(changed).not.toBe(before);
  const rows = inventory(repositoryRoot).filter(row => row.identity.file !== relative).concat(writerRows(relative, changed));
  expect(compare(rows, ledger, repositoryOwners(ledger)).length).toBeGreaterThan(0);
}, 20000);

test('actual interaction replies, reaction cleanup and session UNLINK are explicitly classified', () => {
  const ledger = actualLedger();
  const expected = [
    ['backend/src/services/discordCommandPublication.ts', 'interaction.reply'],
    ['backend/src/services/ticketService.ts', 'interaction.deferReply'],
    ['backend/src/services/ticketService.ts', 'interaction.editReply'],
    ['backend/src/services/ticketService.ts', 'message.reply'],
    ['backend/src/services/discordOverlayCommandService.ts', 'interaction.followUp'],
    ['backend/src/services/reactionRoleService.ts', 'message.reactions.removeAll'],
    ['backend/src/controllers/adminNukeController.ts', 'redis.unlink'],
  ];
  for (const [file, callee] of expected) {
    const actual = writerRows(file, fs.readFileSync(path.join(repositoryRoot, file), 'utf8')).filter(row => row.identity.callee === callee);
    expect(actual.length).toBeGreaterThan(0);
    expect(actual.every(row => ledger.rows.some(prior => prior.writerId === row.writerId && prior.disposition !== 'optional'))).toBe(true);
  }
});

test('all seven actual modal REST dispatches have explicit required caller/funnel provenance', () => {
  const ledger = actualLedger();
  const expected = [['voiceService', 3], ['cosmeticsCommandService', 1], ['chatNameCommandService', 1], ['ticketService', 2]];
  for (const [module, count] of expected) {
    const relative = `backend/src/services/${module}.ts`;
    const calls = writerRows(relative, fs.readFileSync(path.join(repositoryRoot, relative), 'utf8')).filter(row => /\.showModal$/.test(row.identity.callee));
    expect(calls).toHaveLength(count);
    for (const call of calls) {
      const classified = ledger.rows.find(row => row.writerId === call.writerId);
      expect(classified.disposition).toBe('delegated'); expect(classified.family).toBe('discord-sdk-mutation');
      expect(classified.funnelProvenance.kind).toBe('discord-client-rest');
      expect(classified.ownerProofs).toContainEqual(expect.objectContaining({ identity: { file: 'backend/src/runtime/discordClient.ts', owner: 'createRuntimeDiscordClient' }, requiredCalls: ['runtime.required'] }));
      expect(classified.funnelProvenance.chain).toContainEqual(expect.objectContaining({ identity: { file: relative, owner: '<module>' } }));
    }
  }
});

test('modal builders/local helper calls stay local while imported interaction callback aliases are detected', () => {
  const source = `import { ModalBuilder, type ButtonInteraction } from 'discord.js';
    function showModal(value: unknown) { return value; }
    async function open(interaction: ButtonInteraction) { const modal = new ModalBuilder().setTitle('title');
      const { showModal: dispatch } = interaction; await dispatch(modal); showModal(modal); }`;
  const rows = writerRows('backend/src/services/chatNameCommandService.ts', source);
  expect(rows).toHaveLength(1); expect(rows[0].identity.callee).toBe('dispatch'); expect(rows[0].family).toBe('discord-sdk-mutation');
});

test('semantic mutation of the actual formerly omitted modal dispatch fails repository policy', () => {
  const ledger = actualLedger(), relative = 'backend/src/services/chatNameCommandService.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace('await interaction.showModal(modal)', 'await interaction.showModal(otherModal)');
  expect(changed).not.toBe(before);
  const modal = ledger.rows.find(row => row.identity.file === relative && row.identity.callee === 'interaction.showModal');
  expect(modal).toBeDefined();
  const rows = inventory(repositoryRoot).filter(row => row.identity.file !== relative).concat(writerRows(relative, changed));
  expect(compare(rows, ledger, repositoryOwners(ledger))).toContainEqual({ writerId: modal.writerId, reason: 'semantic-shape-changed' });
}, 20000);

test('every actual JSON/form POST caller and the narrow native fetch initializer are bound into required CI', () => {
  const ledger = actualLedger();
  const expected = [['backend/src/server.ts', 3], ['backend/src/controllers/mcpOAuthController.ts', 1],
    ['backend/src/controllers/qaOAuthController.ts', 1], ['backend/src/controllers/devPersonaLoginController.ts', 1],
    ['backend/src/services/aiModerationService.ts', 1], ['backend/src/services/githubService.ts', 2],
    ['backend/src/services/steamAuthService.ts', 1], ['backend/src/services/githubReleaseService.ts', 2]];
  for (const [relative, count] of expected) {
    const source = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
    const imports = require('@babel/parser').parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body;
    const helper = imports.find(node => node.type === 'ImportDeclaration' && /^\.{1,2}\/runtime\/nativeFetch$/.test(node.source.value));
    expect(helper).toBeDefined();
    expect(helper.specifiers).toContainEqual(expect.objectContaining({ type: 'ImportSpecifier',
      imported: expect.objectContaining({ name: 'beginRuntimeFetch' }), local: expect.objectContaining({ name: 'fetch' }) }));
    const actual = writerRows(relative, source).filter(row => row.family === 'http-effect-candidate' && ['fetch', 'fetchImpl', 'f'].includes(row.identity.callee));
    expect(actual).toHaveLength(count);
    expect(actual.every(row => ledger.rows.some(prior => prior.writerId === row.writerId))).toBe(true);
    expect(ledger.sourceBindings).toContainEqual(expect.objectContaining({ identity: { file: relative, owner: '<module>' } }));
  }
  const dispatches = ledger.rows.filter(row => row.family === 'native-fetch-sdk-dispatch');
  expect(dispatches).toHaveLength(2);
  expect(dispatches.every(row => row.disposition === 'delegated' && row.funnelProvenance.kind === 'native-fetch-body-initiation')).toBe(true);
  for (const file of ['backend/src/runtime/nativeFetch.ts', 'backend/tests/runtimeRound8NativeFetch.test.js', 'backend/tests/runtimeRound8NativeCallers.test.js']) {
    expect(ledger.sourceBindings).toContainEqual(expect.objectContaining({ identity: { file, owner: '<module>' } }));
  }
});

test('typed default-fetch aliases retain their actual HTTP dispatch and optional provider policy', () => {
  const source = `import { beginRuntimeFetch as request } from '../runtime/nativeFetch';
    async function verify(callback: typeof request = request) { return callback(url, { method: 'POST', body: params }); }`;
  const rows = writerRows('backend/src/services/steamAuthService.ts', source);
  expect(rows).toHaveLength(1); expect(rows[0].identity.callee).toBe('callback');
  expect(rows[0].family).toBe('http-effect-candidate'); expect(rows[0].sdkReference).toBe('@native-fetch:beginRuntimeFetch');
  const ledger = actualLedger(), relative = 'backend/src/services/steamAuthService.ts';
  const actual = writerRows(relative, fs.readFileSync(path.join(repositoryRoot, relative), 'utf8'));
  expect(actual).toHaveLength(1);
  expect(ledger.rows.find(row => row.writerId === actual[0].writerId)).toEqual(expect.objectContaining({ disposition: 'optional' }));
});

test('suppressing actual native SDK results rejects the helper disposition and every bound caller proof', () => {
  const ledger = actualLedger(), relative = 'backend/src/runtime/nativeFetch.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace('globalThis.fetch(request, prepared)', "Promise.resolve(new Response('{}'))");
  expect(changed).not.toBe(before);
  const owners = repositoryOwners(ledger).filter(owner => owner.identity.file !== relative).concat(sourceOwners(relative, changed));
  const dispatch = ledger.rows.find(row => row.family === 'native-fetch-sdk-dispatch');
  expect(compare(ledger.rows, ledger, owners)).toContainEqual({ writerId: dispatch.writerId, reason: 'delegated-funnel-provenance-invalid' });
  expect(require('./setup/runtime-writer-inventory.cjs').compareProofBindings(repositoryRoot, ledger, owners))
    .toContainEqual({ identity: { file: relative, owner: '<module>' }, reason: 'shared-source-proof-changed' });
});

test('a successful required REST acknowledgement without its actual milestone confirmation forces semantic review', () => {
  const ledger = actualLedger(), relative = 'backend/src/services/githubService.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace("throw new Error('GitHub requested milestone is unconfirmed')", 'return');
  expect(changed).not.toBe(before);
  const rows = inventory(repositoryRoot).filter(row => row.identity.file !== relative).concat(writerRows(relative, changed));
  expect(compare(rows, ledger, repositoryOwners(ledger))).toContainEqual(expect.objectContaining({ reason: 'semantic-shape-changed' }));
});

test('bypassing actual label membership or its literal case-fold helper requires semantic review', () => {
  const ledger = actualLedger(), relative = 'backend/src/services/githubService.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace('labelNamesEqual(name, label.name)', 'true');
  expect(changed).not.toBe(before);
  const rows = inventory(repositoryRoot).filter(row => row.identity.file !== relative).concat(writerRows(relative, changed));
  expect(compare(rows, ledger, repositoryOwners(ledger))).toContainEqual(expect.objectContaining({ reason: 'semantic-shape-changed' }));
  const alteredHelper = before.replace("return new RegExp(`^${literal}(?![\\\\s\\\\S])`, 'iu').test(actual);", 'return true;');
  expect(alteredHelper).not.toBe(before);
  const owners = repositoryOwners(ledger).filter(owner => owner.identity.file !== relative).concat(sourceOwners(relative, alteredHelper));
  expect(require('./setup/runtime-writer-inventory.cjs').compareProofBindings(repositoryRoot, ledger, owners))
    .toContainEqual({ identity: { file: relative, owner: '<module>' }, reason: 'shared-source-proof-changed' });
});

test('dropping actual producer disposal or reverting caller cancellation rejects shared source proofs', () => {
  const ledger = actualLedger();
  for (const [relative, from, to] of [
    ['backend/src/runtime/index.ts', '    unregister();', '    // registration retained'],
    ['backend/src/websocket/bridgeConnection.ts', 'cancelProducerTimer(this.nativeTimer)', 'clearTimeout(this.nativeTimer)'],
    ['backend/src/websocket/handlers.ts', 'cancelProducerTimer(pd.timer)', 'clearTimeout(pd.timer)'],
  ]) {
    const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8'), changed = before.replace(from, to);
    expect(changed).not.toBe(before);
    const owners = repositoryOwners(ledger).filter(owner => owner.identity.file !== relative).concat(sourceOwners(relative, changed));
    expect(require('./setup/runtime-writer-inventory.cjs').compareProofBindings(repositoryRoot, ledger, owners))
      .toContainEqual({ identity: { file: relative, owner: '<module>' }, reason: 'shared-source-proof-changed' });
  }
});

test('releasing the actual MCP read before concrete response closure rejects its shared-source proof', () => {
  const ledger = actualLedger(), relative = 'backend/src/services/mcpClientMetadataService.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace(' || response && !responseEnded && !responseClosed', '');
  expect(changed).not.toBe(before);
  const owners = repositoryOwners(ledger).filter(owner => owner.identity.file !== relative).concat(sourceOwners(relative, changed));
  expect(require('./setup/runtime-writer-inventory.cjs').compareProofBindings(repositoryRoot, ledger, owners))
    .toContainEqual({ identity: { file: relative, owner: '<module>' }, reason: 'shared-source-proof-changed' });
});

test('SDK receiver aliases and destructured operations retain their provider and operation semantics', () => {
  const aliases = `import type { ChatInputCommandInteraction as Interaction } from 'discord.js';
    async function respond(input: Interaction) { const renamed = input; const { reply: send } = renamed;
      await renamed.followUp(payload); await send(payload); }`;
  expect(writerRows(file, aliases).filter(row => row.family === 'discord-sdk-mutation')).toHaveLength(2);
  const redis = `import { getRedisClient as getStore } from '../config/redis';
    async function remove() { const store = await getStore(); const remove = store.unlink.bind(store); await remove(keys); }`;
  expect(writerRows(file, redis).filter(row => /redis-/.test(row.family))).toHaveLength(1);
});

test('the actual Discord/session funnels and required TypeScript test runner are bound into the shared CI proof', () => {
  const ledger = actualLedger();
  for (const file of ['backend/src/runtime/discordClient.ts', 'backend/src/runtime/sessionStore.ts', 'backend/src/testRunner.ts']) {
    expect(ledger.sourceBindings.some(binding => binding.identity.file === file && binding.identity.owner === '<module>')).toBe(true);
  }
  const delegated = ledger.rows.filter(row => row.family === 'discord-sdk-mutation' && row.disposition === 'delegated');
  expect(delegated.length).toBeGreaterThan(0);
  expect(delegated.every(row => row.funnelProvenance?.kind === 'discord-client-rest' && row.funnelProvenance.chain.length >= 2)).toBe(true);
});

test('removing the actual Discord REST required boundary rejects the previously omitted delegated cosmetic caller', () => {
  const ledger = actualLedger(), relative = 'backend/src/runtime/discordClient.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace('runtime.required(`discord-rest:', 'runtime.run(`discord-rest:');
  expect(changed).not.toBe(before);
  const owners = repositoryOwners(ledger).filter(owner => owner.identity.file !== relative).concat(sourceOwners(relative, changed));
  const cosmetic = ledger.rows.find(row => row.identity.file === 'backend/src/services/cosmetics/discordRoleSyncService.ts' && row.identity.callee === 'member.roles.add');
  expect(compare(ledger.rows, ledger, owners)).toContainEqual({ writerId: cosmetic.writerId, reason: 'delegated-funnel-provenance-invalid' });
});

test('making the actual required TypeScript runner suppress failure status rejects its shared CI proof', () => {
  const ledger = actualLedger(), relative = 'backend/src/testRunner.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replaceAll('process.exitCode = 1', 'process.exitCode = 0');
  expect(changed).not.toBe(before);
  const owners = repositoryOwners(ledger).filter(owner => owner.identity.file !== relative).concat(sourceOwners(relative, changed));
  expect(require('./setup/runtime-writer-inventory.cjs').compareProofBindings(repositoryRoot, ledger, owners))
    .toContainEqual({ identity: { file: relative, owner: '<module>' }, reason: 'shared-source-proof-changed' });
});

test('filesystem imports, destructured callbacks, SDK storage and upload aliases participate in policy', () => {
  const aliases = `import { unlink as discard } from 'node:fs'; import upload from 'multer';
    const store = upload.diskStorage({destination,filename});
    const remove = store._removeFile.bind(store);
    async function clean() { discard(path, done); remove(req, file, done); }
    const { writeFile: save } = require('node:fs/promises'); save(path, bytes);`;
  const rows = writerRows(file, aliases);
  expect(rows.filter(row => row.family === 'filesystem-sdk-command-candidate')).toHaveLength(2);
  expect(rows.filter(row => row.family === 'filesystem-upload-storage')).toHaveLength(1);
  expect(rows.filter(row => row.family === 'filesystem-upload-dispatch')).toHaveLength(1);
  expect(writerRows(file, `import fs from 'node:fs'; import { WriteStream as Disk } from 'node:fs';
    fs[operation](path, callback); const output = new Disk(path);`)).toHaveLength(2);
});

test('the actual release upload filesystem SDK, middleware and validation cleanup have explicit dispositions', () => {
  const ledger = actualLedger();
  const actual = inventory(repositoryRoot).filter(row => row.family.startsWith('filesystem-'));
  expect(actual.length).toBeGreaterThan(40);
  for (const row of actual) expect(ledger.rows.some(prior => prior.writerId === row.writerId && ['required', 'delegated', 'optional'].includes(prior.disposition))).toBe(true);
  for (const callee of ['createRuntimeDiskUpload', 'releaseUpload.single', 'fs.unlinkSync']) {
    expect(ledger.rows).toContainEqual(expect.objectContaining({ identity: expect.objectContaining({ file: 'backend/src/server.ts', callee }), disposition: callee === 'fs.unlinkSync' ? 'required' : 'delegated' }));
  }
  const sdk = ledger.rows.filter(row => row.family.startsWith('filesystem-upload-'));
  expect(sdk.length).toBeGreaterThan(4);
  expect(sdk.every(row => row.funnelProvenance?.kind === 'multer-disk-storage' && row.ownerProofs?.some(proof => proof.contract === 'retained-filesystem-upload'))).toBe(true);
}, 20000);

test('suppressing the actual callback cleanup failure rejects the release caller and its required filesystem provenance', () => {
  const ledger = actualLedger(), relative = 'backend/src/runtime/diskUpload.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace('runtime.recordFailure(label, error, evidence(entry, stage));', 'void error;');
  expect(changed).not.toBe(before);
  const owners = repositoryOwners(ledger).filter(owner => owner.identity.file !== relative).concat(sourceOwners(relative, changed));
  const caller = ledger.rows.find(row => row.identity.file === 'backend/src/server.ts' && row.identity.callee === 'createRuntimeDiskUpload');
  expect(compare(ledger.rows, ledger, owners)).toContainEqual({ writerId: caller.writerId, reason: 'delegated-funnel-provenance-invalid' });
});

test('allowing stream close and cleanup to bypass an actual pending pipeline callback rejects upload provenance', () => {
  const ledger = actualLedger(), relative = 'backend/src/runtime/diskUpload.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace('if (!entry.callbackDone) return;', 'if (!entry.callbackDone && !(entry.output?.closed && !entry.finished && entry.cleanupDone)) return;');
  expect(changed).not.toBe(before);
  const owners = repositoryOwners(ledger).filter(owner => owner.identity.file !== relative).concat(sourceOwners(relative, changed));
  const caller = ledger.rows.find(row => row.identity.file === 'backend/src/server.ts' && row.identity.callee === 'createRuntimeDiskUpload');
  expect(compare(ledger.rows, ledger, owners)).toContainEqual({ writerId: caller.writerId, reason: 'delegated-funnel-provenance-invalid' });
  expect(require('./setup/runtime-writer-inventory.cjs').compareProofBindings(repositoryRoot, ledger, owners))
    .toContainEqual({ identity: { file: relative, owner: '<module>' }, reason: 'shared-source-proof-changed' });
});

test('turning post-upload validation cleanup into work accounting alone rejects the actual required deletion', () => {
  const ledger = actualLedger(), relative = 'backend/src/server.ts';
  const before = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');
  const changed = before.replace("runtime.required('filesystem:release-validation-cleanup'", "runtime.run('filesystem:release-validation-cleanup'");
  expect(changed).not.toBe(before);
  const rows = inventory(repositoryRoot).filter(row => row.identity.file !== relative).concat(writerRows(relative, changed));
  const actual = ledger.rows.find(row => row.identity.file === relative && row.identity.callee === 'fs.unlinkSync');
  expect(compare(rows, ledger, repositoryOwners(ledger))).toContainEqual({ writerId: actual.writerId, reason: 'required-disposition-boundary-missing' });
}, 20000);

test('private fence/journal and canonical receipt filesystem writes are classified beyond a server module hash', () => {
  const ledger = actualLedger();
  for (const [file, callee] of [
    ['backend/src/runtime/bootstrap.ts', 'writeFileSync'], ['backend/src/runtime/bootstrap.ts', 'fsyncSync'],
    ['backend/src/runtime/coordinator.ts', 'writeFileSync'], ['backend/src/runtime/coordinator.ts', 'appendFileSync'],
    ['backend/src/runtime/coordinator.ts', 'unlinkSync'], ['backend/src/runtime/messageLedger.ts', 'appendFileSync'],
  ]) expect(ledger.rows.some(row => row.identity.file === file && row.identity.callee === callee && row.disposition !== 'optional')).toBe(true);
  for (const relative of ['backend/src/runtime/fileReads.ts', 'backend/src/runtime/diskUpload.ts', 'backend/src/runtime/cli.ts']) {
    expect(ledger.sourceBindings.some(binding => binding.identity.file === relative && binding.identity.owner === '<module>')).toBe(true);
  }
});
