const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { parse } = require('@babel/parser'); const traverse = require('@babel/traverse').default;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ignored = new Set(['start', 'end', 'loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'tokens', 'errors']);
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).filter(key => !ignored.has(key)).sort().map(key => [key, normalize(value[key])]));
}
function member(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'AwaitExpression') return member(node.argument);
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'TSQualifiedName') return `${member(node.left)}.${member(node.right)}`;
  if (['TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(node.type)) return member(node.expression);
  if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) return `${member(node.object)}.${member(node.property) || node.property.value}`;
  if (['CallExpression', 'OptionalCallExpression'].includes(node.type)) return `${member(node.callee)}()`;
  return '';
}
function ownerPathOf(cursor) {
  let program;
  for (let current = cursor.parentPath; current; current = current.parentPath) {
    if (current.isProgram()) program = current;
    if (current.isFunctionDeclaration() || current.isClassMethod() || current.isObjectMethod()) return current;
    if (current.isFunction()) {
      const parent = current.parentPath;
      if (parent.isVariableDeclarator()) return current;
      if (parent.isCallExpression()) {
        const callee = member(parent.node.callee), first = parent.node.arguments[0];
        if (/\.(get|post|put|patch|delete|use|on|once|process)$/.test(callee) && first?.type === 'StringLiteral') return current;
      }
    }
  }
  return program;
}
function ownerName(current) {
  if (current?.isFunctionDeclaration()) return current.node.id?.name || '<anonymous-function>';
  if (current?.isClassMethod() || current?.isObjectMethod()) return member(current.node.key) || String(current.node.key.value);
  const parent = current?.parentPath;
  if (parent?.isVariableDeclarator()) return member(parent.node.id);
  if (parent?.isCallExpression()) return `${member(parent.node.callee)}:${parent.node.arguments[0].value}`;
  return '<module>';
}
function ownerDescriptor(file, cursor) {
  const calls = new Set(), bindings = {}, exitCodes = [];
  cursor.traverse({ CallExpression(value) { calls.add(member(value.node.callee)); if (member(value.node.callee) === 'process.exit') exitCodes.push(value.node.arguments[0]?.value); }, ReferencedIdentifier(value) {
    const binding = value.scope.getBinding(value.node.name);
    if (binding?.path.isVariableDeclarator() && binding.path.node.init) bindings[value.node.name] = normalize(binding.path.node.init);
    if (binding?.path.isImportSpecifier() || binding?.path.isImportDefaultSpecifier() || binding?.path.isImportNamespaceSpecifier()) {
      bindings[value.node.name] = normalize({ import: binding.path.node, source: binding.path.parent.source });
    }
  } });
  return { identity: { file, owner: ownerName(cursor) }, fingerprint: digest({ body: normalize(cursor.node), bindings }), calls: [...calls].sort(), exitCodes };
}
const mutations = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
// Every installed Redis command is a candidate, including commands whose name
// looks like a read but changes TTL/state. Safe reads are classified explicitly
// in the ledger. A command added by a dependency update cannot evade this scan.
const redisMethods = new Set([...Object.keys(require('@redis/client/dist/lib/commands/index.js').default),
  'exec', 'execAsPipeline', 'multi', 'sendCommand', 'publish', 'sPublish']);
// Inventory every actual fs API candidate, then classify reads separately.
// Import/receiver/destructured aliases and callback SDK funnels share provenance.
const filesystemMethods = new Set(Object.entries(fs).filter(([, value]) => typeof value === 'function').map(([name]) => name));
function typeReference(node, scope) {
  if (!node) return '';
  if (node.type === 'TSTypeQuery') {
    // The buffered fetch default is also used through an injected function
    // parameter typed typeof that import. Preserve that exact HTTP provenance.
    const reference = sdkReference(node.exprName, scope);
    return reference.startsWith('@native-fetch:') ? reference : '';
  }
  if (node.type === 'TSTypeReference') {
    const name = member(node.typeName), binding = scope.getBinding(name);
    const module = binding?.path.parent?.source?.value;
    const imported = binding?.path.node.imported?.name || name;
    if (module === 'discord.js') return imported.endsWith('Builder') ? '@discord-builder:' + imported : '@discord:' + imported;
    if (module && /(?:^|\/)redis$/.test(module)) return '@redis:' + imported;
    if (module === '@prisma/client' || /^Prisma\./.test(name)) return '@prisma:' + imported;
    if (module === 'pg') return '@pg:' + imported;
    if (/^(?:node:)?fs(?:\/promises)?$/.test(module || '')) return '@filesystem:' + imported;
    if (module === 'multer') return '@multer:' + imported;
    for (const parameter of node.typeParameters?.params || []) { const reference = typeReference(parameter, scope); if (reference) return reference; }
  }
  for (const child of node.types || []) { const reference = typeReference(child, scope); if (reference) return reference; }
  return typeReference(node.typeAnnotation, scope);
}
/** Follow lexical receiver/operation aliases, casts, destructuring and bind().
 * Preserve the actual callee in identity; this resolved path is evidence of SDK
 * provenance, and its imports/initializers remain in the semantic fingerprints. */
function sdkReference(node, scope, seen = new Set()) {
  if (!node) return '';
  if (node.type === 'AwaitExpression') return sdkReference(node.argument, scope, seen);
  if (['TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(node.type)) return typeReference(node.typeAnnotation, scope) || sdkReference(node.expression, scope, seen);
  if (node.type === 'Identifier') {
    if (seen.has(node.name)) return node.name;
    const binding = scope.getBinding(node.name), next = new Set([...seen, node.name]);
    const typed = typeReference(binding?.identifier?.typeAnnotation, binding?.scope || scope);
    if (typed) return typed;
    if (binding?.path.isImportSpecifier() || binding?.path.isImportDefaultSpecifier() || binding?.path.isImportNamespaceSpecifier()) {
      const imported = binding.path.node.imported?.name || (binding.path.isImportDefaultSpecifier() ? 'default' : '*');
      const from = binding.path.parent.source.value;
      if (/\/(?:config\/)?redis(?:\.js)?$/.test(from) || ['redis', '@redis/client'].includes(from)) return '@redis:' + imported;
      if (/\/prisma(?:\.js)?$/.test(from) || from === '@prisma/client') return '@prisma:' + imported;
      if (/\/config\/database(?:\.js)?$/.test(from) || from === 'pg') return '@pg:' + imported;
      if (from === '@aws-sdk/client-s3' || /\/config\/storage(?:\.js)?$/.test(from) && imported === 's3') return '@s3:' + imported;
      if (from === 'discord.js') return imported.endsWith('Builder') ? '@discord-builder:' + imported : '@discord:' + imported;
      if (/^(?:node:)?fs(?:\/promises)?$/.test(from)) return '@filesystem:' + imported;
      if (from === 'multer') return '@multer:' + imported;
      if (/\/runtime\/diskUpload(?:\.js)?$/.test(from) && imported === 'createRuntimeDiskUpload') return '@filesystem-upload:' + imported;
      if (/\/runtime\/nativeFetch(?:\.js)?$/.test(from) && imported === 'beginRuntimeFetch') return '@native-fetch:' + imported;
      if (/\/discordService(?:\.js)?$/.test(from) && imported === 'getDiscordClient') return '@discord:getDiscordClient';
      return `${from}:${imported}`;
    }
    if (binding?.path.isVariableDeclarator() && binding.path.node.init) {
      const declaration = binding.path.node;
      if (declaration.id.type === 'ObjectPattern') {
        const property = declaration.id.properties.find(property => property.type === 'ObjectProperty' && member(property.value) === node.name);
        if (property) return `${sdkReference(declaration.init, binding.scope, next)}.${member(property.key)}`;
      }
      return sdkReference(declaration.init, binding.scope, next);
    }
    return node.name;
  }
  if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) {
    const property = member(node.property) || node.property.value;
    // A cache/collection mutation is local even when obtained from an SDK.
    return `${sdkReference(node.object, scope, seen)}.${property}`;
  }
  if (['CallExpression', 'OptionalCallExpression'].includes(node.type)) {
    if (node.callee.type === 'Import' || member(node.callee) === 'require') {
      const from = node.arguments[0]?.value;
      if (/^(?:node:)?fs(?:\/promises)?$/.test(from || '')) return '@filesystem:*';
      if (from === 'multer') return '@multer:default';
      if (node.callee.type === 'Import') return `import:${from}`;
    }
    const callee = sdkReference(node.callee, scope, seen);
    if (/\.bind$/.test(callee)) return callee.slice(0, -5);
    if (/getDiscordClient$/.test(callee)) return '@discord:getDiscordClient()';
    if (/getRedisClient$/.test(callee)) return '@redis:getRedisClient()';
    if (/\.initializeSdkLifetime$/.test(callee)) {
      const initializer = node.arguments[0];
      if (initializer?.type === 'ArrowFunctionExpression' && initializer.body.type !== 'BlockStatement') return sdkReference(initializer.body, scope, seen);
    }
    const callbackIndex = /(?:^|:)runRequiredMutation$/.test(callee) ? 3
      : /(?:^|:)(?:runRequiredEffect|runRequiredLookup)$/.test(callee) ? 2
      : /(?:^|:)runRequiredPublicationPrerequisite$/.test(callee) || /\.(?:run|required)$/.test(callee) ? 1 : -1;
    const callback = node.arguments[callbackIndex];
    if (callback?.type === 'ArrowFunctionExpression' && callback.body.type !== 'BlockStatement') return sdkReference(callback.body, scope, seen);
    return callee + '()';
  }
  if (node.type === 'NewExpression') {
    const reference = sdkReference(node.callee, scope, seen);
    if (reference.startsWith('@discord:') && /Builder$/.test(reference)) return reference.replace('@discord:', '@discord-builder:');
    return reference.startsWith('@') ? reference : '@local:' + reference;
  }
  return member(node);
}
function discordMutation(method, reference) {
  if (/\.cache(?:\.|$)/.test(reference) || reference.startsWith('@discord-builder:')) return false;
  return /(?:\.rest\.|@discord:REST\.)/.test(reference) && ['post', 'put', 'patch', 'delete'].includes(method)
    || ['send', 'edit', 'delete', 'reply', 'followUp', 'deferReply', 'editReply', 'deleteReply', 'deferUpdate', 'update',
    'showModal', 'respond', 'react', 'removeAll', 'bulkDelete', 'kick', 'timeout', 'ban', 'unban', 'pin', 'unpin', 'crosspost', 'disconnect'].includes(method)
    || /^set[A-Z]/.test(method)
    || ['add', 'remove', 'set', 'create'].includes(method) && /\.(roles|members|bans|channels|threads|commands|scheduledEvents|permissionOverwrites)(?:\.|\(|$)/.test(reference);
}
function familyOf(file, node, callee, cursor) {
  const method = callee.split('.').at(-1), argument = node.arguments?.[0];
  const reference = sdkReference(node.callee, cursor.scope), resolvedMethod = reference.split('.').at(-1);
  const filesystemMethod = reference.split(/[.:]/).at(-1);
  if (file.endsWith('/runtime/nativeFetch.ts') && callee === 'globalThis.fetch') return 'native-fetch-sdk-dispatch';
  if (reference.startsWith('@filesystem:') && (filesystemMethods.has(filesystemMethod)
    || /^@filesystem:(?:default|\*)\./.test(reference) && !reference.includes('()')
    || /^@filesystem:WriteStream\.(?:write|end)$/.test(reference))) return 'filesystem-sdk-command-candidate';
  if (reference.startsWith('@filesystem-upload:') && filesystemMethod === 'createRuntimeDiskUpload') return 'filesystem-upload-configuration';
  if (reference.startsWith('@filesystem-upload:') && ['single', 'array', 'fields', 'any', 'none'].includes(filesystemMethod)) return 'filesystem-upload-middleware';
  if (reference.startsWith('@multer:') && filesystemMethod === 'diskStorage') return 'filesystem-upload-storage';
  if (reference.startsWith('@multer:') && ['_handleFile', '_removeFile'].includes(filesystemMethod)) return 'filesystem-upload-dispatch';
  if (reference.startsWith('@multer:') && filesystemMethod === 'memoryStorage') return 'multipart-memory-storage';
  if (reference === '@multer:default') return 'multipart-sdk-configuration';
  if (reference.startsWith('@multer:') && ['single', 'array', 'fields', 'any', 'none'].includes(filesystemMethod)) return 'multipart-sdk-middleware-candidate';
  if (file.endsWith('/lib/requiredEffects.ts') && callee === 'writer.create') return 'required-audit-dispatch';
  if (file.endsWith('/runtime/sessionStore.ts') && callee === 'operation') return 'browser-session-store-dispatch';
  if (reference.startsWith('@discord:') && /\.rest\.request$/.test(reference) && !callee.endsWith('.bind')) return 'discord-rest-dispatch';
  if (reference.startsWith('@s3:') && resolvedMethod === 'send') {
    const command = argument?.type === 'NewExpression' ? sdkReference(argument.callee, cursor.scope).split(':').at(-1) : '';
    return /^(Get|Head|List)/.test(command) ? 's3-sdk-read' : 's3-mutation';
  }
  if (reference.startsWith('@redis:') && redisMethods.has(resolvedMethod)) return 'redis-sdk-command-candidate';
  if (reference.startsWith('@prisma:') && mutations.has(resolvedMethod)) return 'prisma-sdk-mutation';
  if (reference.startsWith('@discord:') && discordMutation(resolvedMethod, reference)) return 'discord-sdk-mutation';
  if (callee === 'messageQueue.add' || file.endsWith('/queues/messagePersist.ts') && callee === 'add') return 'canonical-queue-acceptance';
  if (/^req\.session\.(save|destroy)$/.test(callee)) return 'browser-session-callback';
  if (callee === 'mergeUserInto') return 'transactional-identity-mutation-call';
  if (/^(prisma|tx|deps\.prisma)\./.test(callee) && mutations.has(method)) return 'prisma-model-mutation';
  if (/mcp(Authorization|ClientMetadata)Service\.ts$/.test(file) && /^(this\.db|db)\./.test(callee) && mutations.has(method)) return 'prisma-model-alias';
  if (callee === 's3.send' && argument?.type === 'NewExpression' && /^(PutObject|DeleteObject|CreateBucket)Command$/.test(member(argument.callee))) return 's3-mutation';
  if (/\.(\$executeRaw|\$executeRawUnsafe)$/.test(callee)) return 'prisma-raw-mutation';
  if (!reference.startsWith('@discord:') && !reference.startsWith('@local:')
    && (/^(receiptRedis|multi|pipeline|getRedisClient\(\))\./.test(callee) || file.endsWith('/relay/hudSendReceipt.ts') && /^store\./.test(callee)) && redisMethods.has(method)) return 'redis-alias-mutation-candidate';
  if (!reference.startsWith('@discord:') && !reference.startsWith('@local:')
    && /(?:^|\.)(redis|redisClient|client|c|subscriberClient)(?:\.|\(\)|$)/.test(callee) && redisMethods.has(method)) return 'redis-mutation-candidate';
  if (/githubService\./.test(callee) && /^(create|set|delete|close|update|add|remove|reopen)/.test(method)) return 'github-mutation';
  if (!reference.startsWith('@local:') && !reference.startsWith('@discord-builder:')
    && /\/services\/(?:.*\/)?(?:discord\w*|voiceService|ticketService|reactionRoleService|supporter\w*|cosmetics\w*|chatNameCommandService|moderationActionsService)\.ts$/.test(file)
    && /^(guild|member|message|msg|thread|channel|discordChannel|discordMessage|existing|recovered|event|temp|vc|ch|sys|panel|intro|current|manager|staleNewCodes|client|m|interaction|anyI)(?:\.|$)/.test(callee)
    && (discordMutation(method, callee) || callee === 'manager.create')) return 'discord-sdk-mutation';
  if (file.endsWith('/controllers/migrationController.ts') && callee === 'query') return 'operator-sql-mutation';
  if (file.endsWith('/services/githubService.ts') && (callee === 'rest' && argument?.type === 'StringLiteral' && argument.value !== 'GET' || callee === 'graphql')) return 'managed-github-mutation';
  const options = node.arguments?.[1];
  if ((callee === 'fetch' || reference === 'fetch' || reference === 'globalThis.fetch' || reference.startsWith('@native-fetch:')
    || file.endsWith('/githubReleaseService.ts') && callee === 'f') && options?.type === 'ObjectExpression') {
    const methodProperty = options.properties.find(property => property.type === 'ObjectProperty' && member(property.key) === 'method');
    if (methodProperty && (methodProperty.value.type !== 'StringLiteral' || methodProperty.value.value !== 'GET' && methodProperty.value.value !== 'HEAD')) return 'http-effect-candidate';
  }
  const sql = argument?.type === 'StringLiteral' ? argument.value : argument?.type === 'TemplateLiteral' ? argument.quasis.map(value => value.value.raw).join('') : '';
  if ((reference.startsWith('@pg:') || ['query', 'dbQuery', 'dbQueryFn', 'runQuery', 'db.query', 'deps.query', 'pool.query'].includes(callee) || /\.query$/.test(callee)) && /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|nextval)\b/i.test(sql)) return 'pg-sql-mutation';
  if (/\.(\$queryRaw|\$queryRawUnsafe)$/.test(callee) && /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|nextval)\b/i.test(sql)) return 'prisma-raw-mutation';
  return undefined;
}
function writerRows(file, text) {
  const ast = parse(text, { sourceType: 'unambiguous', plugins: ['typescript'] }); const rows = [], ordinals = new Map();
  function add(cursor, family, callee) {
    if (!family) return;
    const ownerPath = ownerPathOf(cursor), owner = ownerName(ownerPath), base = { file, owner, callee }, key = JSON.stringify(base), occurrence = (ordinals.get(key) || 0) + 1;
    ordinals.set(key, occurrence); const identity = { ...base, occurrence }; const boundary = [];
    for (let current = cursor.parentPath; current; current = current.parentPath) if (current.isCallExpression()) {
      const name = member(current.node.callee);
      if (['runRequiredEffect', 'runRequiredCallback', 'createRequiredAudit', 'runRequiredMutation', 'runRequiredTransaction', 'runtime.required', 'runtime.run'].includes(name)) boundary.push(name);
    }
    const argumentShape = cursor.node.arguments || cursor.node.quasi;
    const bindings = {};
    cursor.traverse({ ReferencedIdentifier(reference) {
      const binding = reference.scope.getBinding(reference.node.name);
      if (binding?.path.isVariableDeclarator() && binding.path.node.init) bindings[reference.node.name] = normalize(binding.path.node.init);
      if (binding?.path.isImportSpecifier() || binding?.path.isImportDefaultSpecifier() || binding?.path.isImportNamespaceSpecifier()) {
        bindings[reference.node.name] = normalize({ import: binding.path.node, source: binding.path.parent.source });
      }
    } });
    rows.push({ writerId: digest(identity).slice(0, 24), identity, family, operationFingerprint: digest({ callee: normalize(cursor.node.callee || cursor.node.tag), arguments: normalize(argumentShape), bindings,
      sdkReference: sdkReference(cursor.node.callee || cursor.node.tag, cursor.scope) }),
      ownerFingerprint: ownerDescriptor(file, ownerPath).fingerprint, boundaries: boundary, originalLine: cursor.node.loc.start.line,
      sdkReference: cursor.isCallExpression() || cursor.isOptionalCallExpression() ? sdkReference(cursor.node.callee, cursor.scope) : undefined });
  }
  traverse(ast, {
    NewExpression(cursor) {
      const callee = member(cursor.node.callee), reference = sdkReference(cursor.node.callee, cursor.scope);
      if (reference.startsWith('@filesystem:')) add(cursor, 'filesystem-sdk-command-candidate', callee);
    },
    CallExpression(cursor) { const callee = member(cursor.node.callee); add(cursor, familyOf(file, cursor.node, callee, cursor), callee); },
    OptionalCallExpression(cursor) { const callee = member(cursor.node.callee); add(cursor, familyOf(file, cursor.node, callee, cursor), callee); },
    TaggedTemplateExpression(cursor) {
      const callee = member(cursor.node.tag), reference = sdkReference(cursor.node.tag, cursor.scope), sql = cursor.node.quasi.quasis.map(value => value.value.raw).join('');
      if (/\.\$executeRaw$/.test(reference) || /\.\$queryRaw$/.test(reference) && /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|nextval)\b/i.test(sql)) add(cursor, 'prisma-tagged-mutation', callee);
    },
  });
  return rows;
}
function inventory(root) {
  const rows = [];
  function visit(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name), file = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory() && !['tests', '__tests__'].includes(entry.name)) visit(absolute);
    else if (entry.isFile() && /\.ts$/.test(file) && !/\.test\.ts$/.test(file) && !file.endsWith('/testRunner.ts')) rows.push(...writerRows(file, fs.readFileSync(absolute, 'utf8')));
  } }
  visit(path.join(root, 'backend/src')); return rows;
}
function sourceOwners(file, text) {
  const ast = parse(text, { sourceType: 'unambiguous', plugins: ['typescript'] }); const result = [];
  traverse(ast, { Function(cursor) {
    const owner = ownerPathOf({ parentPath: cursor });
    if (owner === cursor) result.push(ownerDescriptor(file, cursor));
  }, Program(cursor) { result.push(ownerDescriptor(file, cursor)); } });
  return result;
}
const requiredCalls = new Set(['runRequiredEffect', 'runRequiredCallback', 'createRequiredAudit', 'runRequiredMutation', 'runRequiredTransaction', 'runtime.required']);
function compare(current, ledger, currentOwners = []) {
  const known = new Map(ledger.rows.map(row => [row.writerId, row])); const problems = [];
  const owners = new Map(currentOwners.map(owner => [JSON.stringify(owner.identity), owner]));
  function verifiedProofs(row) {
    if (!Array.isArray(row.ownerProofs) || !row.ownerProofs.length) return false;
    return row.ownerProofs.every(proof => {
      const owner = owners.get(JSON.stringify(proof.identity));
      if (proof.contract === 'retained-filesystem-upload') return owner?.fingerprint === proof.fingerprint
        && proof.identity.file === 'backend/src/runtime/diskUpload.ts' && proof.identity.owner === 'createRuntimeDiskUpload'
        && ['runtime.lease', 'runtime.recordFailure', 'multer.diskStorage', 'handle', 'remove', 'lstat', 'finish']
          .every(call => owner.calls.includes(call));
      if (proof.contract === 'runtime-fence-filesystem') {
        const allowed = {
          'backend/src/runtime/bootstrap.ts': { syncControlDirectory: ['openSync', 'fsyncSync', 'closeSync'], claimProcessFence: ['writeFileSync', 'syncControlDirectory', 'fenceNames'] },
          'backend/src/runtime/coordinator.ts': { recordFailure: ['appendFileSync', 'this.failures.push'], freeze: ['writeFileSync', 'syncControlDirectory', 'this.recordFailure'],
            checkpoint: ['writeFileSync', 'renameSync', 'syncControlDirectory'], performDrain: ['unlinkSync', 'syncControlDirectory', 'this.checkpoint', 'this.recordFailure'] },
          'backend/src/runtime/control.ts': { openRuntimeControl: ['unlinkSync', 'server.listen', 'runtime.drain'] },
        };
        const calls = allowed[proof.identity.file]?.[proof.identity.owner];
        return owner?.fingerprint === proof.fingerprint && calls?.every(call => owner.calls.includes(call));
      }
      if (proof.contract === 'fenced-application-startup-filesystem') return owner?.fingerprint === proof.fingerprint
        && proof.identity.file === 'backend/src/server.ts' && proof.identity.owner === '<module>'
        && ['fs.mkdirSync', 'runtime.isFrozen', 'instrumentHttpHandlers'].every(call => owner.calls.includes(call))
        && ledger.scriptBindings?.some(binding => binding.file === 'backend/runtime-start.sh');
      if (proof.contract === 'canonical-receipt-filesystem') return owner?.fingerprint === proof.fingerprint
        && proof.identity.file === 'backend/src/queues/messagePersist.ts' && proof.identity.owner === '<module>'
        && ['ledger.record', 'ledger.verify', 'runtime.required', 'runtime.registerParticipant'].every(call => owner.calls.includes(call));
      if (proof.contract === 'fenced-startup-cli-fatal') return owner?.fingerprint === proof.fingerprint
        && proof.identity.file === 'backend/src/scripts/applyPostPushPatches.ts' && proof.identity.owner === '<module>'
        && owner.calls.includes('main') && owner.calls.includes('process.exit') && owner.exitCodes.includes(1)
        && Array.isArray(ledger.scriptBindings) && ledger.scriptBindings.some(binding => binding.file === 'backend/runtime-start.sh')
        && ledger.scriptBindings.some(binding => binding.file === 'backend/baseline-migrations.sh');
      return proof.contract === 'retained-required-disposition' && owner?.fingerprint === proof.fingerprint
        && Array.isArray(proof.requiredCalls) && proof.requiredCalls.length > 0
        && proof.requiredCalls.every(call => requiredCalls.has(call) && owner.calls.includes(call))
        && (!proof.transactionClientBound || owner.calls.includes('bindRequiredTransactionClient'));
    });
  }
  function verifiedFunnel(row) {
    const provenance = row.funnelProvenance;
    if (!provenance || !Array.isArray(provenance.chain) || provenance.chain.length < 2) return false;
    if (!provenance.chain.every(link => {
      const owner = owners.get(JSON.stringify(link.identity));
      return owner?.fingerprint === link.fingerprint && Array.isArray(link.calls)
        && link.calls.every(call => owner.calls.includes(call));
    })) return false;
    if (row.family === 'native-fetch-sdk-dispatch') return provenance.kind === 'native-fetch-body-initiation'
      && provenance.chain.some(link => link.identity.file === 'backend/src/runtime/nativeFetch.ts'
        && link.identity.owner === 'beginRuntimeFetch' && ['runtime.initializeSdkLifetime', 'globalThis.fetch'].every(call => link.calls.includes(call)))
      && provenance.chain.some(link => link.identity.file === 'backend/src/services/githubService.ts'
        && link.identity.owner === 'deleteIssue' && link.calls.includes('runRequiredMutation'));
    if (row.family === 'discord-sdk-mutation' || row.family === 'discord-rest-dispatch') {
      return provenance.kind === 'discord-client-rest'
        && provenance.chain.some(link => link.identity.file === 'backend/src/runtime/discordClient.ts'
          && link.identity.owner === 'createRuntimeDiscordClient' && link.calls.includes('runtime.required'))
        && provenance.chain.some(link => link.identity.file === 'backend/src/services/discordService.ts'
          && link.identity.owner === 'start' && link.calls.includes('createRuntimeDiscordClient'))
        && provenance.chain.some(link => link.identity.file === row.identity.file && link.identity.owner === '<module>');
    }
    if (row.family.startsWith('filesystem-upload-') || row.identity.file === 'backend/src/runtime/diskUpload.ts' && row.family.startsWith('multipart-')) return provenance.kind === 'multer-disk-storage'
      && provenance.chain.some(link => link.identity.file === 'backend/src/runtime/diskUpload.ts'
        && link.identity.owner === 'createRuntimeDiskUpload'
        && ['runtime.lease', 'runtime.recordFailure', 'multer.diskStorage', 'handle', 'remove', 'finish'].every(call => link.calls.includes(call)))
      && provenance.chain.some(link => link.identity.file === 'backend/src/server.ts' && link.identity.owner === '<module>'
        && link.calls.includes('createRuntimeDiskUpload') && link.calls.includes('releaseUpload.single'));
    if (row.identity.file === 'backend/src/runtime/messageLedger.ts') return provenance.kind === 'canonical-receipt-filesystem'
      && provenance.chain.some(link => link.identity.file === row.identity.file && link.identity.owner === row.identity.owner)
      && provenance.chain.some(link => link.identity.file === 'backend/src/queues/messagePersist.ts' && link.identity.owner === '<module>'
        && ['ledger.record', 'ledger.verify', 'runtime.required', 'runtime.registerParticipant'].every(call => link.calls.includes(call)));
    return provenance.chain.some(link => link.identity.file === row.identity.file);
  }
  for (const row of current) {
    const prior = known.get(row.writerId); known.delete(row.writerId);
    if (!prior) { problems.push({ writerId: row.writerId, reason: 'unclassified-writer' }); continue; }
    if (prior.operationFingerprint !== row.operationFingerprint || prior.ownerFingerprint !== row.ownerFingerprint) problems.push({ writerId: row.writerId, reason: 'semantic-shape-changed' });
    if (prior.disposition === 'required' && !row.boundaries.some(value => ['runRequiredMutation', 'runRequiredEffect', 'runRequiredCallback', 'runtime.required'].includes(value)) && !verifiedProofs(prior)) problems.push({ writerId: row.writerId, reason: 'required-disposition-boundary-missing' });
    if (prior.disposition === 'delegated' && !verifiedProofs(prior)) problems.push({ writerId: row.writerId, reason: 'delegated-owner-proof-invalid' });
    // Older detector-only synthetic fixtures need only their owner proof. Every
    // actual repository delegated entry carries its concrete funnel chain.
    if (prior.disposition === 'delegated' && (prior.funnelProvenance || row.family.startsWith('filesystem-upload-') || ['discord-sdk-mutation', 'discord-rest-dispatch'].includes(row.family))
      && !verifiedFunnel(prior)) problems.push({ writerId: row.writerId, reason: 'delegated-funnel-provenance-invalid' });
    if (!['required', 'optional', 'delegated'].includes(prior.disposition)) problems.push({ writerId: row.writerId, reason: 'classification-pending' });
  }
  for (const writerId of known.keys()) problems.push({ writerId, reason: 'classified-writer-removed' });
  return problems;
}
function scriptFingerprint(text) {
  return digest(text.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).map(line => line.trim()).join('\n'));
}
/** Bind shared helper bodies and script semantics as well as call-site rows.
 * Imports/aliases can preserve a caller name while changing its disposition. */
function compareProofBindings(root, ledger, owners) {
  const byIdentity = new Map(owners.map(owner => [JSON.stringify(owner.identity), owner])); const problems = [];
  for (const proof of ledger.sourceBindings || []) {
    const current = byIdentity.get(JSON.stringify(proof.identity));
    if (!current || current.fingerprint !== proof.fingerprint) problems.push({ identity: proof.identity, reason: 'shared-source-proof-changed' });
  }
  for (const proof of ledger.scriptBindings || []) {
    const filename = path.join(root, proof.file);
    if (!fs.existsSync(filename) || scriptFingerprint(fs.readFileSync(filename, 'utf8')) !== proof.fingerprint) problems.push({ file: proof.file, reason: 'startup-script-proof-changed' });
  }
  return problems;
}
module.exports = { normalize, member, writerRows, inventory, sourceOwners, compare, scriptFingerprint, compareProofBindings };
