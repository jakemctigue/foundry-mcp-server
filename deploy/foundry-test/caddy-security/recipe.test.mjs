import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import test from 'node:test';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const candidateWorkflow = () => read('../../../.github/workflows/caddy-security-candidate.yml');

test('both upstream stages are pinned to reviewed digests and amd64', () => {
  const recipe = read('Dockerfile');
  assert.match(recipe, /FROM --platform=linux\/amd64 caddy:2\.11\.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS runtime-base/);
  assert.match(recipe, /FROM --platform=linux\/amd64 caddy:2\.11\.4-builder-alpine@sha256:1a1689db91cfb390b2d856a1b3774e796852822cd723fa54c475b272f82bb4b7 AS builder/);
  assert.match(recipe, /FROM runtime-base AS runtime/);
  assert.equal((recipe.match(/^FROM /gm) ?? []).length, 3);
  assert.doesNotMatch(recipe, /^ARG /m);
});

test('compiler version and low concurrency are fixed, not downloaded on demand', () => {
  const recipe = read('Dockerfile');
  for (const setting of ['GOTOOLCHAIN=local', 'GOMAXPROCS=1', 'GOMEMLIMIT=512MiB', 'GOFLAGS=-p=1', 'CGO_ENABLED=0']) {
    assert.ok(recipe.includes(setting), setting);
  }
  assert.match(recipe, /test "\$\(go env GOVERSION\)" = 'go1\.26\.8'/);
  assert.match(recipe, /GOPROXY=https:\/\/proxy\.golang\.org/);
  assert.match(recipe, /GOSUMDB=sum\.golang\.org/);
});

test('build uses exactly the original Caddy release without plugin or dependency changes', () => {
  const recipe = read('Dockerfile');
  assert.match(recipe, /xcaddy build v2\.11\.4 --output \/usr\/bin\/caddy/);
  assert.doesNotMatch(recipe, /--with\b|--replace\b|--embed\b|go get\b|apk (?:add|upgrade)\b/);
  assert.match(recipe, /diff -u \/tmp\/original-modules\.txt \/tmp\/rebuilt-modules\.txt/);
  assert.match(recipe, /COPY --from=runtime-base \/usr\/bin\/caddy \/tmp\/original-caddy/);
});

test('build records compiler and module provenance and copies only binary and evidence', () => {
  const recipe = read('Dockerfile');
  assert.match(recipe, /go version -m \/usr\/bin\/caddy > \/tmp\/go-buildinfo\.txt/);
  assert.match(recipe, /caddy list-modules --packages --versions > \/tmp\/module-versions\.txt/);
  const copies = recipe.split('\n').filter(line => line.startsWith('COPY '));
  assert.equal(copies.length, 4);
  assert.ok(copies.every(line => line.startsWith('COPY --from=')));
  assert.doesNotMatch(recipe, /^\s*(?:ENTRYPOINT|CMD|VOLUME|EXPOSE|USER)\b/m);
  assert.doesNotMatch(recipe, /(?:docker|systemctl)\s+(?:run|start|enable|restart)|FOUNDRY_|MCP_|\.env|license/i);
});

test('build context denies accidental inclusion of private files', () => {
  assert.equal(read('.dockerignore').trim(), '**');
});

test('handoff requires actual scan, private configuration validation, and authenticated parity gates', () => {
  const docs = read('README.md');
  for (const gate of ['CVE-2026-56862', 'not vulnerability-free', 'owner 401', 'GM', 'caddy validate', '--network none', 'rollback', '--scanners vuln', '--platform linux/amd64']) {
    assert.ok(docs.includes(gate), gate);
  }
  assert.match(docs, /not a hard container memory limit/);
  assert.match(docs, /No image has been built/);
  assert.doesNotMatch(docs, /--ignore-unfixed|--ignorefile|--password\s+\S+|docker compose up/);
});

test('offline validation mounts the imported owner-authentication file read-only', () => {
  const docs = read('README.md');
  assert.match(docs, /source=\/ABSOLUTE\/PRIVATE\/owner-auth\.caddy,target=\/run\/secrets\/owner-auth\.caddy,readonly/);
});

test('candidate CI has hard build limits, immutable scanner input, and no deployment authority', () => {
  const workflow = candidateWorkflow();
  for (const required of ['pull_request:', 'workflow_dispatch:', 'contents: read', 'persist-credentials: false', 'DOCKER_BUILDKIT: "0"', '--memory 2g', '--memory-swap 2g', '--cpu-period 100000', '--cpu-quota 100000', '--input evidence/image.tar', '--scanners vuln', '--disable-telemetry']) {
    assert.ok(workflow.includes(required), required);
  }
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|packages: write|docker push|docker login|gcloud|continue-on-error|ignore-unfixed/);
});

test('candidate CI records source identity, checksum-verifies scanner, and preserves scan evidence', () => {
  const workflow = candidateWorkflow();
  for (const required of ['2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a', 'sha256sum --check', 'CVE-2026-56862', 'go1.26.8', 'report.Metadata.ImageID', 'report.Results', 'retention-days: 14', 'caddy-security-candidate-${{ env.SOURCE_SHA }}', 'SHA256SUMS', 'scanner-version.json']) {
    assert.ok(workflow.includes(required), required);
  }
  assert.match(workflow, /if: always\(\)/);
});

test('existing configuration CI also runs the recipe tests', () => {
  assert.ok(read('../../../.github/workflows/foundry-test-config.yml').includes('node --test deploy/foundry-test/caddy-security/recipe.test.mjs'));
});

function verifySyntheticScan(change = () => {}) {
  const id = `sha256:${'a'.repeat(64)}`;
  const sha = 'b'.repeat(40);
  const report = {Metadata: {ImageID: id}, Results: [{Type: 'gobinary', Target: 'usr/bin/caddy', Packages: [{Name: 'stdlib', Version: 'v1.26.8'}], Vulnerabilities: []}]};
  change(report);
  const image = {Id: id, Os: 'linux', Architecture: 'amd64', Config: {Labels: {'org.opencontainers.image.revision': sha, 'org.opencontainers.image.source': 'https://github.com/example/repo'}}};
  const files = new Map(Object.entries({
    'evidence/image-id.txt': id,
    'evidence/trivy.json': JSON.stringify(report),
    'evidence/image-inspect.json': JSON.stringify([image]),
    'evidence/go-buildinfo.txt': '/usr/bin/caddy: go1.26.8\n',
    'evidence/caddy-version.txt': 'v2.11.4 h1:example\n',
  }));
  const block = candidateWorkflow().split('      - name: Verify image identity,')[1];
  const script = block.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)[1].replace(/^          /gm, '');
  const fakeFs = {readFileSync: path => {assert.ok(files.has(path), path); return files.get(path);}, writeFileSync: (path, value) => files.set(path, value), appendFileSync: (path, value) => files.set(path, (files.get(path) ?? '') + value)};
  new Script(script).runInNewContext({require: name => {if (name === 'node:fs') return fakeFs; if (name === 'node:assert/strict') return assert; throw new Error(`Unexpected module ${name}`);}, process: {env: {SOURCE_SHA: sha, SOURCE_REPOSITORY: 'example/repo', GITHUB_STEP_SUMMARY: 'summary'}}});
  return files;
}

test('scan gate accepts target fix while preserving other critical findings for review', () => {
  const files = verifySyntheticScan(report => report.Results[0].Vulnerabilities.push({VulnerabilityID: 'CVE-OTHER', Severity: 'CRITICAL', PkgName: 'example', InstalledVersion: '1', FixedVersion: '2'}));
  assert.equal(JSON.parse(files.get('evidence/remaining-critical-high.json')).length, 1);
  assert.match(files.get('summary'), /1 other critical\/high/);
});

test('scan gate fails closed for wrong image, missing binary, wrong Go, or retained TLS advisory', () => {
  for (const change of [
    report => {report.Metadata.ImageID = 'wrong';},
    report => {report.Results = [];},
    report => {report.Results[0].Packages[0].Version = 'v1.26.3';},
    report => {report.Results[0].Vulnerabilities.push({VulnerabilityID: 'CVE-2026-56862'});},
  ]) assert.throws(() => verifySyntheticScan(change));
});
