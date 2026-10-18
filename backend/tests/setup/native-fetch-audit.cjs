const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { parse } = require('@babel/parser'), traverse = require('@babel/traverse').default;
const { normalize, member } = require('./runtime-writer-inventory.cjs');

// Resolve native defaults as well as explicit imports, lexical aliases,
// destructuring and bound callbacks. Discord receiver .fetch stays separate.
function nativeReference(node, scope, seen = new Set()) {
  if (!node) return undefined;
  if (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) return nativeReference(node.expression, scope, seen);
  if (node.type === 'Identifier') {
    if (seen.has(node.name)) return undefined;
    const binding = scope.getBinding(node.name), next = new Set([...seen, node.name]);
    if (!binding) return node.name === 'fetch' ? 'native-global' : undefined;
    if (binding.path.isImportSpecifier() && /\/runtime\/nativeFetch(?:\.js)?$/.test(binding.path.parent.source.value)
      && binding.path.node.imported.name === 'beginRuntimeFetch') return 'native-buffered-initiation';
    if (binding.path.isVariableDeclarator()) {
      const { id, init } = binding.path.node;
      if (id.type === 'ObjectPattern') {
        const property = id.properties.find(value => value.type === 'ObjectProperty' && member(value.value) === node.name);
        if (property?.key.name === 'fetch' && ['globalThis', 'global'].includes(member(init))) return 'native-global-alias';
      }
      return nativeReference(init, binding.scope, next);
    }
    const parameter = binding.path.isAssignmentPattern() ? binding.path.node : binding.path.parentPath?.isAssignmentPattern() ? binding.path.parentPath.node : undefined;
    if (parameter) { const reference = nativeReference(parameter.right, binding.scope, next); if (reference) return 'native-or-injected-default'; }
    return undefined;
  }
  if (node.type === 'LogicalExpression' || node.type === 'ConditionalExpression') {
    const branches = node.type === 'LogicalExpression' ? [node.left, node.right] : [node.consequent, node.alternate];
    return branches.some(value => nativeReference(value, scope, new Set(seen))) ? 'native-or-injected-default' : undefined;
  }
  if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) {
    const property = node.computed ? node.property.value : node.property.name;
    if (property === 'fetch' && ['globalThis', 'global'].includes(member(node.object)) && !scope.getBinding(member(node.object))) return 'native-global';
  }
  if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && /\.bind$/.test(member(node.callee))) return nativeReference(node.callee.object, scope, seen);
  return undefined;
}
function nativeCalls(file, source) {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript'] }), result = [];
  function visit(cursor) {
    const reference = nativeReference(cursor.node.callee, cursor.scope); if (!reference) return;
    let owner = '<module>', ownerPath = cursor.findParent(value => value.isProgram());
    for (let at = cursor.parentPath; at; at = at.parentPath) {
      if (at.isFunctionDeclaration()) { owner = at.node.id.name; ownerPath = at; break; }
      if (at.isObjectMethod() || at.isClassMethod()) { owner = member(at.node.key); ownerPath = at; break; }
      if (at.isFunction() && at.parentPath.isVariableDeclarator()) { owner = member(at.parentPath.node.id); ownerPath = at; break; }
      if (at.isFunction() && at.parentPath.isCallExpression() && /\.(get|post|on|use)$/.test(member(at.parentPath.node.callee)) && at.parentPath.node.arguments[0]?.type === 'StringLiteral') {
        owner = member(at.parentPath.node.callee) + ':' + at.parentPath.node.arguments[0].value; ownerPath = at; break;
      }
    }
    const bindings = {};
    ownerPath.traverse({ ReferencedIdentifier(value) {
      const binding = value.scope.getBinding(value.node.name);
      if (binding?.path.isVariableDeclarator() && binding.path.node.init) bindings[value.node.name] = normalize(binding.path.node.init);
      if (binding?.path.isImportSpecifier() || binding?.path.isImportDefaultSpecifier() || binding?.path.isImportNamespaceSpecifier()) {
        bindings[value.node.name] = normalize({ import: binding.path.node, source: binding.path.parent.source });
      }
    } });
    result.push({ file, owner, callee: member(cursor.node.callee), reference, line: cursor.node.loc.start.line,
      ownerFingerprint: crypto.createHash('sha256').update(JSON.stringify({ body: normalize(ownerPath.node), bindings })).digest('hex') });
  }
  traverse(ast, { CallExpression: visit, OptionalCallExpression: visit });
  return result;
}
function audit(root) {
  const results = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '__tests__') walk(path.join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const filename = path.join(directory, entry.name), relative = path.relative(root, filename).split(path.sep).join('/');
        results.push(...nativeCalls(relative, fs.readFileSync(filename, 'utf8')));
      }
    }
  }
  walk(path.join(root, 'backend/src'));
  return results;
}
module.exports = { audit, nativeCalls };
