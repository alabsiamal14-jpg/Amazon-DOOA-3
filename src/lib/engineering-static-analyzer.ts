import fs from 'fs';
import path from 'path';
import type {
  EngineeringDiagnosisType,
  EngineeringEvidenceRef,
  EngineeringFinding,
  EngineeringFirestoreRuleNode,
  EngineeringFirestoreRuleOp,
  EngineeringReachability,
  EngineeringRuntimeLayer,
} from '../types.ts';

export interface FileRuntimeProfile {
  file: string;
  layer: EngineeringRuntimeLayer;
  reachability: EngineeringReachability;
  clientChain: string[] | null;
  serverChain: string[] | null;
  imports: string[];
}

export interface ProjectRuntimeGraph {
  profiles: Map<string, FileRuntimeProfile>;
  layerCounts: {
    server: number;
    client: number;
    shared: number;
    config_rules: number;
    unreferenced: number;
  };
}

const CONFIG_AND_RULES_FILES = new Set([
  'firestore.rules',
  'firebase-applet-config.json',
  'firebase-blueprint.json',
  'package.json',
  'tsconfig.json',
  'index.html',
  'metadata.json',
  'vite.config.ts',
]);

const SCANNER_ENGINE_AND_RULES_FILES = new Set([
  'src/lib/engineering-architect-store.ts',
  'src/lib/engineering-static-analyzer.ts',
  'src/server/routes/engineering-architect.ts',
  'src/components/AdminEngineeringArchitectPage.tsx',
  'src/services/codebaseScanner.ts',
  'src/services/zipProjectAnalyzer.ts',
  'src/components/AdminDeveloperAdvisor.tsx',
]);

export function isScannerEngineOrRulesFile(relPath: string): boolean {
  return (
    SCANNER_ENGINE_AND_RULES_FILES.has(relPath) ||
    relPath.startsWith('e2e/') ||
    relPath.endsWith('.test.ts') ||
    relPath.endsWith('.test.tsx')
  );
}

const KNOWN_SERVER_DIR_PREFIXES = ['src/server/', 'src/db/', 'src/middleware/'];
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json'];

/**
 * Strip JS/TS comments line-by-line (preserving line count)
 * so naive keyword occurrences inside comments don't cause false positives.
 */
export function stripCommentsPreservingLines(source: string): string {
  // Replace /* ... */ block comments with matching newlines to preserve line numbers
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  // Strip // line comments
  out = out
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n');
  return out;
}

function resolveImportTarget(
  fromFile: string,
  specifier: string,
  availableFiles: Set<string>
): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromDir = path.posix.dirname(fromFile);
  const rawJoined = path.posix.normalize(path.posix.join(fromDir, specifier));

  if (availableFiles.has(rawJoined)) return rawJoined;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (availableFiles.has(`${rawJoined}${ext}`)) return `${rawJoined}${ext}`;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (availableFiles.has(`${rawJoined}/index${ext}`)) return `${rawJoined}/index${ext}`;
  }
  return null;
}

function extractRelativeImports(fromFile: string, content: string, availableFiles: Set<string>): string[] {
  let clean = stripCommentsPreservingLines(content);
  // Strip pure compile-time `import type ... from '...'` and `export type ... from '...'`
  // so TypeScript type-only imports do not create false browser reachability chains.
  clean = clean.replace(
    /^\s*(?:import|export)\s+type\b[\s\S]*?\bfrom\s+['"][^'"]+['"]\s*;?/gm,
    ''
  );
  const targets = new Set<string>();
  const re = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    const resolved = resolveImportTarget(fromFile, spec, availableFiles);
    if (resolved) targets.add(resolved);
  }
  return Array.from(targets);
}

function bfsChains(roots: string[], adjacency: Map<string, string[]>): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const queue: string[] = [];

  for (const r of roots) {
    if (adjacency.has(r) && !chains.has(r)) {
      chains.set(r, [r]);
      queue.push(r);
    }
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currChain = chains.get(curr)!;
    for (const next of adjacency.get(curr) || []) {
      if (!chains.has(next)) {
        chains.set(next, [...currChain, next]);
        queue.push(next);
      }
    }
  }
  return chains;
}

export function buildProjectRuntimeGraph(fileTexts: Map<string, string>): ProjectRuntimeGraph {
  const availableFiles = new Set(fileTexts.keys());
  const adjacency = new Map<string, string[]>();

  for (const [rel, text] of fileTexts.entries()) {
    if (/\.(tsx?|jsx?)$/.test(rel)) {
      adjacency.set(rel, extractRelativeImports(rel, text, availableFiles));
    } else {
      adjacency.set(rel, []);
    }
  }

  const clientRoots = adjacency.has('src/main.tsx')
    ? ['src/main.tsx']
    : adjacency.has('src/App.tsx')
    ? ['src/App.tsx']
    : [];
  const clientChains = bfsChains(clientRoots, adjacency);
  const serverChains = bfsChains(['server.ts'], adjacency);

  const profiles = new Map<string, FileRuntimeProfile>();
  const layerCounts = {
    server: 0,
    client: 0,
    shared: 0,
    config_rules: 0,
    unreferenced: 0,
  };

  for (const rel of fileTexts.keys()) {
    const cChain = clientChains.get(rel) || null;
    const sChain = serverChains.get(rel) || null;

    let layer: EngineeringRuntimeLayer;
    let reachability: EngineeringReachability;

    const isConfigOrRule =
      CONFIG_AND_RULES_FILES.has(rel) ||
      rel.endsWith('.rules') ||
      rel.endsWith('.json') ||
      rel.endsWith('.css') ||
      rel.endsWith('.html') ||
      rel.endsWith('.md');

    if (isConfigOrRule) {
      layer = 'config_rules';
      reachability = cChain
        ? 'reachable_from_client'
        : sChain
        ? 'reachable_from_server'
        : 'config_or_rules';
    } else if (cChain && sChain) {
      layer = 'shared';
      reachability = 'reachable_from_both';
    } else if (cChain) {
      layer = 'client';
      reachability = 'reachable_from_client';
    } else if (sChain || rel === 'server.ts' || KNOWN_SERVER_DIR_PREFIXES.some((p) => rel.startsWith(p))) {
      layer = 'server';
      reachability = sChain ? 'reachable_from_server' : 'unreachable_or_dead';
    } else {
      layer = 'unreferenced';
      reachability = 'unreachable_or_dead';
    }

    layerCounts[layer]++;
    profiles.set(rel, {
      file: rel,
      layer,
      reachability,
      clientChain: cChain,
      serverChain: sChain,
      imports: adjacency.get(rel) || [],
    });
  }

  return { profiles, layerCounts };
}

// =========================================================================
// Full Structural Firestore Rules Parser & Nested Subcollection Analyzer
// =========================================================================

export interface FirestoreRulesSummary {
  totalMatchBlocks: number;
  helperFunctions: Array<{ name: string; checksAuth: boolean; checksVerifiedEmail: boolean; checksRoleLookup: boolean }>;
  nodes: EngineeringFirestoreRuleNode[];
  openWildcardNodes: EngineeringFirestoreRuleNode[];
  partialOpenNodes: Array<{ node: EngineeringFirestoreRuleNode; openVerbs: string[]; guardedVerbs: string[] }>;
  nestedSubcollectionNodes: EngineeringFirestoreRuleNode[];
  productPublicWriteNode: EngineeringFirestoreRuleNode | null;
  ordersNode: EngineeringFirestoreRuleNode | null;
  usersParentNode: EngineeringFirestoreRuleNode | null;
}

function splitTopLevelOrBranches(expr: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (depth === 0 && ch === '|' && expr[i + 1] === '|') {
      branches.push(expr.slice(start, i).trim());
      start = i + 2;
      i++;
    }
  }
  const tail = expr.slice(start).trim();
  if (tail) branches.push(tail);
  return branches.length > 0 ? branches : [expr];
}

function classifyRuleExpression(expr: string): {
  is_open_public: boolean;
  requires_auth: boolean;
  role_guard: string | null;
  ownership_guard: string | null;
  field_validation: boolean;
} {
  const compact = expr.replace(/\s+/g, ' ').trim();
  const isOpen = /^true$/i.test(compact);
  const roleRe = /\b(isAdmin|isStaff|isDriver|isSovereignAdmin|userHasRole)\s*\([^)]*\)/g;
  const roleMatches = compact.match(roleRe);

  const topBranches = splitTopLevelOrBranches(compact);
  const branchRequiresAuth = (branch: string) =>
    /request\.auth\s*!=\s*null/.test(branch) ||
    /\b(isAdmin|isStaff|isDriver|isSovereignAdmin|userHasRole|isSignedIn|isOwner)\s*\([^)]*\)/.test(branch);

  const requiresAuth =
    topBranches.length > 0 && topBranches.every((b) => branchRequiresAuth(b));

  const ownershipGuard =
    /request\.auth\.uid\s*==\s*([A-Za-z0-9_.]+)/.exec(compact)?.[0] ||
    /([A-Za-z0-9_.]+)\s*==\s*request\.auth\.uid/.exec(compact)?.[0] ||
    null;
  const fieldValidation =
    /request\.resource\.data\./.test(compact) || /\.affectedKeys\(\)/.test(compact);

  return {
    is_open_public: isOpen,
    requires_auth: requiresAuth,
    role_guard: roleMatches ? Array.from(new Set(roleMatches)).join(' | ') : null,
    ownership_guard: ownershipGuard,
    field_validation: fieldValidation,
  };
}

export function parseFirestoreRulesFull(rulesText: string): FirestoreRulesSummary {
  const helperFunctions: FirestoreRulesSummary['helperFunctions'] = [];
  const fnRe = /function\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{([\s\S]*?)\}/g;
  let fm: RegExpExecArray | null;
  while ((fm = fnRe.exec(rulesText)) !== null) {
    const body = fm[2];
    helperFunctions.push({
      name: fm[1],
      checksAuth: /request\.auth\s*!=\s*null/.test(body),
      checksVerifiedEmail: /email_verified\s*==\s*true/.test(body),
      checksRoleLookup: /\.data\.role\s+in\s+roles/.test(body),
    });
  }

  // Parse match blocks with brace tracking while retaining exact 1-indexed line numbers
  const lines = rulesText.split(/\r?\n/);
  interface StackFrame {
    kind: 'service' | 'function' | 'match';
    segment: string;
    fullPath: string;
    nodeIndex: number | null;
    braceDepthAtOpen: number;
  }

  const nodes: EngineeringFirestoreRuleNode[] = [];
  const stack: StackFrame[] = [];
  let braceDepth = 0;

  let pendingAllowLine: number | null = null;
  let pendingAllowBuffer = '';

  const flushAllowStatement = (targetNodeIndex: number | null, stmt: string) => {
    if (targetNodeIndex === null) return;
    const match = /^\s*allow\s+([^:]+):\s*if\s+([\s\S]+?)\s*;\s*$/.exec(stmt);
    if (!match) return;
    const verbs = match[1].trim();
    const expression = match[2].replace(/\s+/g, ' ').trim();
    const classified = classifyRuleExpression(expression);
    const op: EngineeringFirestoreRuleOp = {
      verb: verbs,
      expression,
      ...classified,
    };
    nodes[targetNodeIndex].operations.push(op);
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    const cleanLine = rawLine.replace(/\/\/.*$/, '');
    const trimmed = cleanLine.trim();
    // Strip Firestore path wildcards like {userId} or {document=**} before counting block braces!
    const braceOnlyLine = cleanLine.replace(/\{[A-Za-z0-9_=*]+\}/g, '');
    const opens = (braceOnlyLine.match(/\{/g) || []).length;
    const closes = (braceOnlyLine.match(/\}/g) || []).length;

    // Detect match header opening: e.g. `match /users/{userId}/cart/{itemId} {`
    const matchHeader = /^match\s+(\S+)\s*\{$/.exec(trimmed);
    if (matchHeader) {
      const segment = matchHeader[1];
      const isDatabasesRoot = segment.startsWith('/databases/');
      const parentMatchFrame = [...stack].reverse().find((s) => s.kind === 'match' && !s.segment.startsWith('/databases/'));
      const parentFull = parentMatchFrame ? parentMatchFrame.fullPath : '';
      const normSeg = segment.startsWith('/') ? segment : `/${segment}`;
      const fullPath = isDatabasesRoot ? segment : `${parentFull}${normSeg}`;

      let newNodeIdx: number | null = null;
      if (!isDatabasesRoot) {
        newNodeIdx = nodes.length;
        const segments = fullPath.split('/').filter(Boolean);
        const pathDepth = segments.length >= 3 && !fullPath.includes('{document=**}')
          ? Math.ceil(segments.length / 2)
          : 1;
        const syntacticDepth = parentMatchFrame && parentMatchFrame.nodeIndex !== null
          ? nodes[parentMatchFrame.nodeIndex].depth + 1
          : 1;
        const effectiveDepth = Math.max(syntacticDepth, pathDepth);

        let resolvedParentPath = parentMatchFrame ? parentMatchFrame.fullPath : null;
        if (!resolvedParentPath && segments.length >= 4) {
          const candidateParent = `/${segments.slice(0, -2).join('/')}`;
          const parentNode = nodes.find((n) => n.path === candidateParent);
          if (parentNode) {
            resolvedParentPath = parentNode.path;
            if (!parentNode.nested_children.includes(fullPath)) {
              parentNode.nested_children.push(fullPath);
            }
          }
        }

        nodes.push({
          path: fullPath,
          parent_path: resolvedParentPath,
          depth: effectiveDepth,
          line: lineNo,
          operations: [],
          nested_children: [],
        });
        if (parentMatchFrame && parentMatchFrame.nodeIndex !== null) {
          if (!nodes[parentMatchFrame.nodeIndex].nested_children.includes(fullPath)) {
            nodes[parentMatchFrame.nodeIndex].nested_children.push(fullPath);
          }
        }
      }

      braceDepth += opens;
      stack.push({
        kind: 'match',
        segment,
        fullPath,
        nodeIndex: newNodeIdx,
        braceDepthAtOpen: braceDepth,
      });
      braceDepth -= closes;
      while (stack.length > 0 && braceDepth < stack[stack.length - 1].braceDepthAtOpen) {
        stack.pop();
      }
      continue;
    }

    // Track braces for service / function blocks
    if (/^(service|function)\s+/.test(trimmed) && opens > 0) {
      braceDepth += opens;
      stack.push({
        kind: trimmed.startsWith('service') ? 'service' : 'function',
        segment: trimmed.split(/\s+/)[0],
        fullPath: '',
        nodeIndex: null,
        braceDepthAtOpen: braceDepth,
      });
      braceDepth -= closes;
      while (stack.length > 0 && braceDepth < stack[stack.length - 1].braceDepthAtOpen) {
        stack.pop();
      }
      continue;
    }

    // Multi-line or single-line allow collection
    const activeMatch = [...stack].reverse().find((s) => s.kind === 'match' && s.nodeIndex !== null);
    if (pendingAllowLine !== null) {
      pendingAllowBuffer += ' ' + trimmed;
      if (trimmed.includes(';')) {
        flushAllowStatement(activeMatch?.nodeIndex ?? null, pendingAllowBuffer);
        pendingAllowLine = null;
        pendingAllowBuffer = '';
      }
    } else if (/^allow\s+/.test(trimmed)) {
      if (trimmed.includes(';')) {
        flushAllowStatement(activeMatch?.nodeIndex ?? null, trimmed);
      } else {
        pendingAllowLine = lineNo;
        pendingAllowBuffer = trimmed;
      }
    }

    braceDepth += opens;
    braceDepth -= closes;
    while (stack.length > 0 && braceDepth < stack[stack.length - 1].braceDepthAtOpen) {
      stack.pop();
    }
  }

  const openWildcardNodes = nodes.filter(
    (n) =>
      n.path.includes('{document=**}') &&
      n.operations.some((op) => op.is_open_public && /\b(write|update|delete|create)\b/.test(op.verb))
  );

  const partialOpenNodes: FirestoreRulesSummary['partialOpenNodes'] = [];
  for (const n of nodes) {
    if (n.path.includes('{document=**}')) continue;
    const openOps = n.operations.filter(
      (op) => op.is_open_public && /\b(write|update|delete|create)\b/.test(op.verb)
    );
    const guardedOps = n.operations.filter((op) => !op.is_open_public);
    if (openOps.length > 0 && guardedOps.length > 0) {
      partialOpenNodes.push({
        node: n,
        openVerbs: openOps.map((o) => o.verb),
        guardedVerbs: guardedOps.map((o) => o.verb),
      });
    }
  }

  const nestedSubcollectionNodes = nodes.filter(
    (n) => n.depth >= 2 && !n.path.includes('{document=**}')
  );
  const productPublicWriteNode = nodes.find((n) => n.path === '/products/{productId}') || null;
  const ordersNode = nodes.find((n) => n.path === '/orders/{orderId}') || null;
  const usersParentNode = nodes.find((n) => n.path === '/users/{userId}') || null;

  return {
    totalMatchBlocks: nodes.length,
    helperFunctions,
    nodes,
    openWildcardNodes,
    partialOpenNodes,
    nestedSubcollectionNodes,
    productPublicWriteNode,
    ordersNode,
    usersParentNode,
  };
}

// =========================================================================
// Context-Aware Code Checks (Zero Naive Keyword False Positives)
// =========================================================================

const SENSITIVE_ENV_VARS = new Set([
  'GEMINI_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_PASSWORD',
  'ADMIN_JWT_SECRET',
  'SESSION_SECRET',
  'FIREBASE_SERVICE_ACCOUNT',
  'RESEND_API_KEY',
  'SQL_PASSWORD',
  'SQL_ADMIN_PASSWORD',
  'DATABASE_URL',
]);

export interface ClientSecretTrace {
  file: string;
  line: number;
  varName: string;
  snippet: string;
  layer: EngineeringRuntimeLayer;
  clientChain: string[];
}

export function traceSecretEnvUsageInBrowserPaths(
  fileTexts: Map<string, string>,
  graph: ProjectRuntimeGraph
): {
  confirmedClientLeaks: ClientSecretTrace[];
  sharedNonSecretEnvFiles: string[];
  suppressedServerEnvFiles: string[];
  suppressedScannerFiles: string[];
  suppressedServerGuardedSharedFiles: string[];
} {
  const confirmedClientLeaks: ClientSecretTrace[] = [];
  const sharedNonSecretEnvFiles: string[] = [];
  const suppressedServerEnvFiles: string[] = [];
  const suppressedScannerFiles: string[] = [];
  const suppressedServerGuardedSharedFiles: string[] = [];

  for (const [rel, text] of fileTexts.entries()) {
    if (!/\.(tsx?|jsx?)$/.test(rel)) continue;
    const profile = graph.profiles.get(rel);
    if (!profile) continue;

    // Requirement #1: Never treat scanner/rule files' literal pattern strings as leaks
    if (isScannerEngineOrRulesFile(rel)) {
      if (/process\.env/.test(text)) {
        suppressedScannerFiles.push(rel);
      }
      continue;
    }

    const clean = stripCommentsPreservingLines(text);
    const lines = clean.split(/\r?\n/);

    let hasAnyProcessEnv = false;
    let hasServerGuardInClientOrShared = false;

    for (let i = 0; i < lines.length; i++) {
      const lineStr = lines[i];
      // Ignore regex literal matches like /process\.env.../
      if (/\/[^/\n]*process\\?\.env[^/\n]*\//.test(lineStr)) continue;
      const envRegex = /\bprocess\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g;
      let em: RegExpExecArray | null;
      while ((em = envRegex.exec(lineStr)) !== null) {
        hasAnyProcessEnv = true;
        const varName = em[1] || em[2];
        if (!varName) continue;

        if (profile.layer === 'server' || profile.layer === 'unreferenced') {
          continue;
        }

        // Requirement #2: Check whether the secret access is inside a server-only runtime guard
        // (e.g., `if (typeof window === 'undefined')`) before concluding browser code receives the value.
        const surroundingWindow = lines.slice(Math.max(0, i - 6), i + 2).join('\n');
        const hasServerOnlyRuntimeGuard =
          /typeof\s+window\s*===\s*['"]undefined['"]|typeof\s+document\s*===\s*['"]undefined['"]/.test(
            surroundingWindow
          );
        if (hasServerOnlyRuntimeGuard) {
          hasServerGuardInClientOrShared = true;
          continue;
        }

        // Only flag REAL sensitive secret access when statically reachable by browser bundle!
        if (SENSITIVE_ENV_VARS.has(varName) && profile.clientChain) {
          confirmedClientLeaks.push({
            file: rel,
            line: i + 1,
            varName,
            snippet: text.split(/\r?\n/)[i]?.trim().slice(0, 160) || lineStr.trim().slice(0, 160),
            layer: profile.layer,
            clientChain: profile.clientChain,
          });
        }
      }
    }

    if (hasAnyProcessEnv) {
      if (profile.layer === 'server') {
        suppressedServerEnvFiles.push(rel);
      } else if (hasServerGuardInClientOrShared && !confirmedClientLeaks.some((l) => l.file === rel)) {
        suppressedServerGuardedSharedFiles.push(rel);
      } else if (
        (profile.layer === 'client' || profile.layer === 'shared') &&
        !confirmedClientLeaks.some((l) => l.file === rel)
      ) {
        sharedNonSecretEnvFiles.push(rel);
      }
    }
  }

  return {
    confirmedClientLeaks,
    sharedNonSecretEnvFiles,
    suppressedServerEnvFiles,
    suppressedScannerFiles,
    suppressedServerGuardedSharedFiles,
  };
}

export interface DialogContextMatch {
  file: string;
  line: number;
  callType: 'alert' | 'confirm' | 'open';
  snippet: string;
  isGuardedByTryCatch: boolean;
  isReachableFromClient: boolean;
  clientChain: string[] | null;
  isAdminOnlyPath: boolean;
}

export function analyzeUiDialogsWithReachability(
  fileTexts: Map<string, string>,
  graph: ProjectRuntimeGraph
): {
  unguardedBlockingDialogs: DialogContextMatch[];
  tryCatchGuardedOpens: DialogContextMatch[];
  unreachableDialogs: DialogContextMatch[];
} {
  const unguardedBlockingDialogs: DialogContextMatch[] = [];
  const tryCatchGuardedOpens: DialogContextMatch[] = [];
  const unreachableDialogs: DialogContextMatch[] = [];

  for (const [rel, text] of fileTexts.entries()) {
    if (!rel.startsWith('src/components/') || !rel.endsWith('.tsx')) continue;
    if (isScannerEngineOrRulesFile(rel)) continue;

    const profile = graph.profiles.get(rel);
    const isReachable = Boolean(profile?.clientChain);
    const clean = stripCommentsPreservingLines(text);
    const lines = clean.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const m = /\bwindow\.(alert|confirm|open)\s*\(/.exec(lines[i]);
      if (!m) continue;
      const callType = m[1] as 'alert' | 'confirm' | 'open';

      // Look back up to 5 lines for a surrounding `try {`
      const contextWindow = lines.slice(Math.max(0, i - 5), i + 4).join('\n');
      const isGuardedByTryCatch =
        callType === 'open' && /\btry\s*\{[\s\S]*window\.open/.test(contextWindow);

      const entry: DialogContextMatch = {
        file: rel,
        line: i + 1,
        callType,
        snippet: text.split(/\r?\n/)[i]?.trim().slice(0, 160) || '',
        isGuardedByTryCatch,
        isReachableFromClient: isReachable,
        clientChain: profile?.clientChain || null,
        isAdminOnlyPath: /Admin|PricingAI|WhatsAppSupplier|AIVideo/.test(rel),
      };

      if (!isReachable) {
        unreachableDialogs.push(entry);
      } else if (isGuardedByTryCatch) {
        tryCatchGuardedOpens.push(entry);
      } else {
        unguardedBlockingDialogs.push(entry);
      }
    }
  }

  return { unguardedBlockingDialogs, tryCatchGuardedOpens, unreachableDialogs };
}

export interface XssContextMatch {
  file: string;
  line: number;
  snippet: string;
  hasSanitizer: boolean;
  hasUntrustedInput: boolean;
  isReachableFromClient: boolean;
  clientChain: string[] | null;
  diagnosis: EngineeringDiagnosisType;
}

export function analyzeDangerouslySetInnerHtml(
  fileTexts: Map<string, string>,
  graph: ProjectRuntimeGraph
): XssContextMatch[] {
  const matches: XssContextMatch[] = [];

  for (const [rel, text] of fileTexts.entries()) {
    if (!/\.(tsx|jsx)$/.test(rel)) continue;
    if (isScannerEngineOrRulesFile(rel)) continue;

    const profile = graph.profiles.get(rel);
    const clean = stripCommentsPreservingLines(text);
    const lines = clean.split(/\r?\n/);
    const fileHasSanitizerImport = /\b(DOMPurify|sanitizeHtml|escapeHtml|xss)\b/.test(clean);

    for (let i = 0; i < lines.length; i++) {
      if (!/\bdangerouslySetInnerHTML\b/.test(lines[i])) continue;
      const surrounding = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 5)).join('\n');

      // Extract expression passed to __html: <expr>
      const exprMatch = /__html\s*:\s*([^}\n]+)/.exec(surrounding);
      const expr = exprMatch?.[1]?.trim() || '';
      const isStaticStringLiteral = /^(['"`])[^${}]*\1$/.test(expr);
      const hasSanitizer =
        /\b(DOMPurify\.sanitize|sanitizeHtml|escapeHtml|sanitize|JSON\.stringify)\b/.test(surrounding) ||
        (fileHasSanitizerImport && /\bsanitize\s*\(/.test(surrounding));
      const hasUntrustedInput =
        !isStaticStringLiteral &&
        !hasSanitizer &&
        /[A-Za-z_][A-Za-z0-9_.]*/.test(expr);

      const isReachable = Boolean(profile?.clientChain);
      const diagnosis: EngineeringDiagnosisType =
        isReachable && !hasSanitizer && hasUntrustedInput
          ? 'suspected_needs_test'
          : 'design_or_perf_improvement';

      matches.push({
        file: rel,
        line: i + 1,
        snippet: text.split(/\r?\n/)[i]?.trim().slice(0, 160) || '',
        hasSanitizer,
        hasUntrustedInput,
        isReachableFromClient: isReachable,
        clientChain: profile?.clientChain || null,
        diagnosis,
      });
    }
  }

  return matches;
}

export interface PackageAndAiModelAuditResult {
  genaiDeclaredRange: string | null;
  genaiInstalledVersion: string | null;
  genaiSupportsThinkingLevel: boolean;
  genaiRangeCompatible: boolean;
  activeConfiguredModels: string[];
  legacyServerRoutesLines: Array<{ line: number; snippet: string }>;
  shouldFlagLegacyServerModels: boolean;
  notesAr: string[];
}

/**
 * Requirement #7: Never recommend updating a library or AI model before verifying
 * the actually installed package version, exported capabilities, and active project configuration.
 */
export function verifyInstalledPackageAndAiModelCompatibility(
  rootDir: string,
  fileTexts: Map<string, string>
): PackageAndAiModelAuditResult {
  const notesAr: string[] = [];
  let genaiDeclaredRange: string | null = null;
  let genaiInstalledVersion: string | null = null;
  let genaiSupportsThinkingLevel = false;
  let genaiRangeCompatible = true;

  const pkgJsonText = fileTexts.get('package.json');
  if (pkgJsonText) {
    try {
      const pkg = JSON.parse(pkgJsonText);
      genaiDeclaredRange = String(pkg?.dependencies?.['@google/genai'] || '') || null;
    } catch {
      // ignore parse failure
    }
  }

  // Check actual installed package on disk in node_modules/@google/genai
  const resolvedRoot = path.resolve(rootDir);
  const installedPkgPath = path.resolve(resolvedRoot, 'node_modules/@google/genai/package.json');
  if (fs.existsSync(installedPkgPath)) {
    try {
      const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf8'));
      genaiInstalledVersion = String(installedPkg?.version || '') || null;
    } catch {
      // ignore
    }
  }

  const installedDtsPath = path.resolve(resolvedRoot, 'node_modules/@google/genai/dist/genai.d.ts');
  const fallbackDtsPath = path.resolve(resolvedRoot, 'node_modules/@google/genai/dist/index.d.ts');
  const dtsPath = fs.existsSync(installedDtsPath)
    ? installedDtsPath
    : fs.existsSync(fallbackDtsPath)
    ? fallbackDtsPath
    : null;
  if (dtsPath) {
    try {
      const dtsContent = fs.readFileSync(dtsPath, 'utf8');
      genaiSupportsThinkingLevel = /\bThinkingLevel\b/.test(dtsContent);
    } catch {
      // ignore
    }
  }

  if (genaiDeclaredRange && genaiInstalledVersion) {
    const cleanRange = genaiDeclaredRange.replace(/^[~^>=<\s]+/, '');
    const [decMajor, decMinor] = cleanRange.split('.').map((n) => Number(n) || 0);
    const [instMajor, instMinor] = genaiInstalledVersion.split('.').map((n) => Number(n) || 0);
    if (genaiDeclaredRange.startsWith('^')) {
      genaiRangeCompatible = instMajor === decMajor && instMinor >= decMinor;
    } else if (genaiDeclaredRange.startsWith('~')) {
      genaiRangeCompatible = instMajor === decMajor && instMinor === decMinor;
    }
    if (genaiRangeCompatible) {
      notesAr.push(
        `التحقق الفعلي من @google/genai: الإصدار المثبت (${genaiInstalledVersion}) متوافق مع النطاق المعلن (${genaiDeclaredRange})${genaiSupportsThinkingLevel ? ' ويدعم ThinkingLevel فعلياً' : ''}، لذا لم تُصدر توصية ترقية غير مبررة.`
      );
    }
  }

  // Inspect active verified AI routes to confirm what models are actually deployed & available here
  const activeRouteFiles = [
    'src/server/routes/engineering-architect.ts',
    'src/server/routes/smart-assistant.ts',
    'src/server/routes/bulk-import.ts',
    'src/server/routes/employee-assistant.ts',
  ];
  const configuredSet = new Set<string>();
  for (const rf of activeRouteFiles) {
    const content = fileTexts.get(rf);
    if (!content) continue;
    const modelLiterals = content.match(/['"](gemini-[a-z0-9.\-]+)['"]/g) || [];
    for (const raw of modelLiterals) {
      configuredSet.add(raw.replace(/['"]/g, ''));
    }
  }
  const activeConfiguredModels = Array.from(configuredSet);

  const serverTs = fileTexts.get('server.ts') || '';
  const legacyServerRoutesLines: Array<{ line: number; snippet: string }> = [];
  if (serverTs) {
    const lines = serverTs.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/gemini-flash-latest|gemini-3\.8-flash/.test(lines[i])) {
        legacyServerRoutesLines.push({
          line: i + 1,
          snippet: lines[i].trim().slice(0, 180),
        });
      }
    }
  }

  // Only recommend aligning server.ts model fallback aliases if active routes actually verify
  // replacement models AND installed SDK version was verified first.
  const shouldFlagLegacyServerModels =
    legacyServerRoutesLines.length > 0 &&
    Boolean(genaiInstalledVersion) &&
    activeConfiguredModels.includes('gemini-4-hydrogen');

  return {
    genaiDeclaredRange,
    genaiInstalledVersion,
    genaiSupportsThinkingLevel,
    genaiRangeCompatible,
    activeConfiguredModels,
    legacyServerRoutesLines,
    shouldFlagLegacyServerModels,
    notesAr,
  };
}

/**
 * Enforce Requirement #4: Verify EVERY cited file actually exists before emitting any finding.
 */
export function verifyFindingFileReferences(
  finding: EngineeringFinding,
  rootDir: string,
  fileTexts: Map<string, string>
): EngineeringFinding | null {
  const resolvedRoot = path.resolve(rootDir);

  const verifiedEvidence: EngineeringEvidenceRef[] = [];
  const seenEvidence = new Set<string>();
  for (const ev of finding.evidence) {
    const abs = path.resolve(resolvedRoot, ev.file);
    const existsOnDisk = fs.existsSync(abs) && fs.statSync(abs).isFile();
    const content = fileTexts.get(ev.file);
    if (!existsOnDisk || content === undefined) continue;

    const lineCount = content.split(/\r?\n/).length;
    const safeLine = ev.line && ev.line >= 1 && ev.line <= lineCount ? ev.line : 1;
    const evKey = `${ev.file}:${safeLine}:${ev.snippet}`;
    if (seenEvidence.has(evKey)) continue;
    seenEvidence.add(evKey);

    verifiedEvidence.push({
      ...ev,
      line: safeLine,
      verified_from_disk: true,
    });
  }

  const verifiedAffected = Array.from(
    new Set(
      finding.affected_files.filter((f) => {
        const abs = path.resolve(resolvedRoot, f);
        return fs.existsSync(abs) && fs.statSync(abs).isFile();
      })
    )
  );

  if (verifiedAffected.length === 0) {
    return null;
  }

  return {
    ...finding,
    evidence: verifiedEvidence,
    affected_files: verifiedAffected,
  };
}
