/**
 * Static checker: every controller route under apps/api/src/workspaces/ that
 * accepts a ':id' (or ':wsId') path parameter must be protected by
 * WorkspaceMemberGuard at either the class or method level.
 *
 * Exits 1 on any missing guard. Emits a machine-readable summary to stdout.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Finding = {
  file: string;
  className: string;
  method: string;
  path: string;
  reason: string;
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, acc);
    else if (full.endsWith('.controller.ts')) acc.push(full);
  }
  return acc;
}

const HTTP_DECORATORS = ['@Get', '@Post', '@Patch', '@Put', '@Delete'];

type ClassInfo = {
  name: string;
  classDecorators: string[];
  routePrefix: string | null;
  body: string;
};

/** Collect lines that are decorators contiguously attached to a given line. */
function decoratorsBefore(lines: string[], idx: number): string[] {
  const out: string[] = [];
  let i = idx - 1;
  while (i >= 0) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('//')) {
      i--;
      continue;
    }
    if (line.startsWith('@')) {
      // single-line decorator OR start of multi-line — collect until line ends with close paren / no open paren
      let collected = line;
      // If the decorator call spans multiple lines (opens paren but doesn't close)…
      while (
        (collected.match(/\(/g)?.length ?? 0) >
        (collected.match(/\)/g)?.length ?? 0)
      ) {
        i--;
        if (i < 0) break;
        collected = `${lines[i].trim()} ${collected}`;
      }
      out.push(collected);
      i--;
    } else {
      break;
    }
  }
  return out.reverse();
}

function classesIn(source: string): ClassInfo[] {
  const lines = source.split(/\r?\n/);
  const classes: ClassInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*export\s+class\s+(\w+)/);
    if (!m) continue;
    const name = m[1];
    const decos = decoratorsBefore(lines, i);
    const controllerDeco = decos.find((d) => d.startsWith('@Controller'));
    const routePrefix = controllerDeco
      ? (controllerDeco.match(/@Controller\s*\(\s*['"`]([^'"`]+)['"`]/) ?? [])[1] ?? null
      : null;
    const bodyStart = source.indexOf('{', source.indexOf(`class ${name}`));
    const bodyEnd = findMatchingBrace(source, bodyStart);
    classes.push({
      name,
      classDecorators: decos,
      routePrefix,
      body: source.slice(bodyStart, bodyEnd),
    });
  }
  return classes;
}

function methodsIn(body: string): Array<{
  name: string;
  decorators: string[];
  path: string | null;
  httpVerb: string;
}> {
  const lines = body.split(/\r?\n/);
  const out: ReturnType<typeof methodsIn> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:async\s+)?(\w+)\s*\(/);
    if (!m) continue;
    if (['constructor', 'if', 'for', 'while', 'return', 'switch', 'catch'].includes(m[1])) continue;
    const decos = decoratorsBefore(lines, i);
    const httpDeco = decos.find((d) =>
      HTTP_DECORATORS.some((h) => d.startsWith(h)),
    );
    if (!httpDeco) continue;
    const verb = httpDeco.match(/^@(\w+)/)![1].toUpperCase();
    const pathMatch = httpDeco.match(/['"`]([^'"`]+)['"`]/);
    out.push({
      name: m[1],
      decorators: decos,
      path: pathMatch ? pathMatch[1] : null,
      httpVerb: verb,
    });
  }
  return out;
}

function findMatchingBrace(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

function hasMemberGuard(decorators: string[]): boolean {
  return decorators.some((d) => /UseGuards\b[\s\S]*WorkspaceMemberGuard/.test(d));
}

function joinPath(prefix: string | null, sub: string | null): string {
  if (!prefix && !sub) return '/';
  if (!prefix) return `/${sub!.replace(/^\/+/, '')}`;
  if (!sub) return `/${prefix.replace(/^\/+/, '')}`;
  return `/${prefix.replace(/^\/+/, '').replace(/\/+$/, '')}/${sub.replace(/^\/+/, '')}`;
}

function main(): void {
  const root = join(process.cwd(), 'apps/api/src/workspaces');
  const files = walk(root);
  const findings: Finding[] = [];
  let totalRoutes = 0;
  let guardedRoutes = 0;

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const classes = classesIn(src);
    for (const cls of classes) {
      const classGuarded = hasMemberGuard(cls.classDecorators);
      const methods = methodsIn(cls.body);
      for (const method of methods) {
        const fullPath = joinPath(cls.routePrefix, method.path);
        if (!/:(id|wsId)\b/.test(fullPath)) continue;
        totalRoutes++;
        const guarded = classGuarded || hasMemberGuard(method.decorators);
        if (!guarded) {
          findings.push({
            file: file.replace(process.cwd() + '/', ''),
            className: cls.name,
            method: method.name,
            path: `${method.httpVerb} ${fullPath}`,
            reason: 'WorkspaceMemberGuard not applied at class or method level',
          });
        } else {
          guardedRoutes++;
        }
      }
    }
  }

  const summary = {
    scannedFiles: files.length,
    totalRoutesWithId: totalRoutes,
    guardedRoutes,
    missing: findings,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (findings.length > 0) {
    console.error(`[guard-coverage] FAIL: ${findings.length} unguarded :id route(s)`);
    process.exit(1);
  }
  console.log(`[guard-coverage] OK (${guardedRoutes}/${totalRoutes} routes guarded)`);
}

main();
