import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import test from 'node:test'

const { load } = createRequire(import.meta.url)('js-yaml')
const workflow = load(readFileSync(new URL('../../.gitea/workflows/release-images.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['build-and-push']
const steps = job.steps
const scripts = steps.filter(step => step.run)

test('only fork tags use ci and the intended registry repositories', () => {
  assert.deepEqual(workflow.on, { push: { tags: ['v*-eric.*'] } })
  assert.equal(job['runs-on'], 'ci')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.equal(job.env.REGISTRY, '192.168.200.101:54453')
  assert.equal(job.env.API_IMAGE_REPOSITORY, 'zhangzhicheng/opengym-api')
  assert.equal(job.env.WEB_IMAGE_REPOSITORY, 'zhangzhicheng/opengym-web')
  assert.equal(job.env.SOURCE_URL, 'https://gitea.blueloverest.site:44443/zhangzhicheng/eric-openGym')
})

test('run blocks are valid fail-fast POSIX shell except best-effort logout', () => {
  assert.equal(job.defaults.run.shell, 'sh')
  for (const step of scripts) {
    const result = spawnSync('sh', ['-n'], { input: step.run, encoding: 'utf8' })
    assert.equal(result.status, 0, `${step.name}: ${result.stderr}`)
    if (step.if !== 'always()') assert.match(step.run, /^set -eu\n/)
    assert.equal(step['continue-on-error'], undefined)
  }
})

test('native tests and licence checks gate both builds and publication', () => {
  const checks = steps.findIndex(step => step.name === 'Native source tests and generated assets')
  const builds = steps.map((step, index) => step.run?.includes('docker build ') ? index : -1).filter(index => index >= 0)
  const login = steps.findIndex(step => step.name === 'Login to Gitea Registry')
  const push = steps.findIndex(step => step.run?.includes('docker push '))
  assert.equal(builds.length, 2)
  assert.ok(checks >= 0 && builds.every(index => checks < index && index < login))
  assert.ok(login < push)
  const commands = steps[checks].run.trim().split('\n')
  for (const command of [
    'node --test --test-concurrency=2 api/test/*.test.js',
    'npm test --prefix frontend -- --maxWorkers=2',
    'node scripts/catalogue/check-media.mjs'
  ]) {
    assert.ok(commands.includes(command))
  }
  assert.ok(!scripts.some(step => step.run.includes('release-check.mjs')))
})

test('both builds share metadata and source labels; web has APP_BUILD', () => {
  const builds = scripts.filter(step => step.run.includes('docker build '))
  assert.match(builds[0].run, /--target default -f api\/Dockerfile/)
  assert.ok(builds[0].run.trimEnd().endsWith(' ./api'))
  assert.match(builds[1].run, /docker build -f web\/Dockerfile/)
  assert.ok(builds[1].run.includes('--build-arg APP_BUILD="$VERSION"'))
  assert.ok(builds[1].run.trimEnd().endsWith(' .'))
  for (const step of builds) {
    for (const name of ['VERSION', 'VCS_REF', 'BUILD_DATE']) {
      assert.ok(step.run.includes(`--build-arg ${name}="$${name}"`))
    }
    assert.ok(step.run.includes('org.opencontainers.image.source=$SOURCE_URL'))
    assert.ok(step.run.includes('org.opencontainers.image.licenses=AGPL-3.0-or-later'))
    for (const tag of ['$VERSION', 'sha-$VCS_REF', 'latest']) assert.ok(step.run.includes(`:${tag}"`))
  }
})

test('login uses environment secrets; push tag ordering is shared', () => {
  const login = steps.find(step => step.name === 'Login to Gitea Registry')
  assert.deepEqual(login.env, {
    REGISTRY_USER: '${{ secrets.REGISTRY_USER }}',
    REGISTRY_PASSWORD: '${{ secrets.REGISTRY_PASSWORD }}'
  })
  assert.ok(login.run.includes('--password-stdin'))
  const push = scripts.find(step => step.run.includes('docker push '))
  assert.ok(push.run.includes('for tag in "$VERSION" "sha-$VCS_REF" latest; do'))
  for (const image of ['API', 'WEB']) assert.ok(push.run.includes(`docker push "$REGISTRY/$${image}_IMAGE_REPOSITORY:$tag"`))
})
