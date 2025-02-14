const test = require('brittle')
const ram = require('random-access-memory')
const tmp = require('test-tmp')

const Corestore = require('..')

test('basic replication', async function (t) {
  const store1 = new Corestore(ram)
  const store2 = new Corestore(ram)

  const core1 = store1.get({ name: 'core-1' })
  const core2 = store1.get({ name: 'core-2' })
  await core1.append('hello')
  await core2.append('world')

  const core3 = store2.get({ key: core1.key })
  const core4 = store2.get({ key: core2.key })

  replicate(t, store1, store2)

  t.alike(await core3.get(0), Buffer.from('hello'))
  t.alike(await core4.get(0), Buffer.from('world'))
})

test('replicating cores created after replication begins', async function (t) {
  const store1 = new Corestore(ram)
  const store2 = new Corestore(ram)

  replicate(t, store1, store2)

  const core1 = store1.get({ name: 'core-1' })
  const core2 = store1.get({ name: 'core-2' })
  await core1.append('hello')
  await core2.append('world')

  const core3 = store2.get({ key: core1.key })
  const core4 = store2.get({ key: core2.key })

  t.alike(await core3.get(0), Buffer.from('hello'))
  t.alike(await core4.get(0), Buffer.from('world'))
})

test('replicating cores using discovery key hook', async function (t) {
  const dir = await tmp(t)
  let store1 = new Corestore(dir)
  const store2 = new Corestore(ram)

  const core = store1.get({ name: 'main' })
  await core.append('hello')
  const key = core.key

  await store1.close()
  store1 = new Corestore(dir)

  const [s1, s2] = replicate(t, store1, store2)

  const core2 = store2.get(key)
  t.alike(await core2.get(0), Buffer.from('hello'))

  // teardown streams so replication sessions are freed
  s1.destroy()
  s2.destroy()

  await store1.close()
})

test('session replication', async function (t) {
  const store1 = new Corestore(ram)
  const store2 = new Corestore(ram, { primaryKey: Buffer.alloc(32).fill('a') })

  await store1.ready()
  await store2.ready()

  const ns1 = store1.namespace('a')
  const ns2 = store2.namespace('a')
  const ns3 = ns1.session({ primaryKey: store2.primaryKey })

  const ns1core = ns1.get({ name: 'main' })
  const ns2core = ns2.get({ name: 'main' })
  const ns3core = ns3.get({ name: 'main' })
  await Promise.all([ns1core.ready(), ns2core.ready(), ns3core.ready()])

  t.unlike(ns3core.key, ns1core.key, 'override primaryKey')
  t.alike(ns3core.key, ns2core.key, 'Inherit namespace')

  const reset = ns3.session({ primaryKey: store1.primaryKey, namespace: null })

  const core0 = store1.get({ name: 'main' })
  const core1 = reset.get({ name: 'main' })
  await Promise.all([core0.ready(), core1.ready()])

  t.alike(core1.key, core0.key, 'reset namespace and primaryKey')

  await core1.append('hello')

  const remote = new Corestore(ram)

  replicate(t, remote, store1)

  const clone1 = remote.get({ key: core1.key })
  t.alike(await clone1.get(0), Buffer.from('hello'), 'share replication streams with a session')
})

test('on-off replication', async function (t) {
  const store1 = new Corestore(ram.reusable())
  const store2 = new Corestore(ram.reusable())

  replicate(t, store1, store2)

  const a = store1.get({ name: 'a' })
  await a.ready()

  await new Promise(resolve => setImmediate(resolve))

  await a.close()

  const clone = store2.get(a.key)

  await new Promise(resolve => setImmediate(resolve))

  const a2 = store1.get({ name: 'a' })

  await a2.append('hello world')

  t.ok(!!(await clone.get(0)), 'replicated')
})

test('active replication', async function (t) {
  const store1 = new Corestore(ram)
  const store2 = new Corestore(ram)

  const a = store1.get({ name: 'a' })
  const b = store1.get({ name: 'b' })

  await a.append('hello')
  await b.append('world')

  const sessionsInitial = a.sessions.length + b.sessions.length

  const s1 = store1.replicate(true)
  const s2 = store2.replicate(false)
  s1.pipe(s2).pipe(s1)

  const sessionsAfter = a.sessions.length + b.sessions.length
  t.ok(sessionsAfter > sessionsInitial)
})

test('passive replication', async function (t) {
  const store1 = new Corestore(ram, { passive: true })
  const store2 = new Corestore(ram)

  const a = store1.get({ name: 'a' })
  const b = store1.get({ name: 'b' })

  await a.append('hello')
  await b.append('world')

  const sessionsInitial = a.sessions.length + b.sessions.length

  const s1 = store1.replicate(true)
  const s2 = store2.replicate(false)
  s1.pipe(s2).pipe(s1)

  const sessionsAfter = a.sessions.length + b.sessions.length
  t.is(sessionsInitial, sessionsAfter)

  const c = store2.get({ key: a.key })
  const d = store2.get({ key: b.key })

  t.alike(await c.get(0), Buffer.from('hello'))
  t.alike(await d.get(0), Buffer.from('world'))

  const sessionsFinal = a.sessions.length + b.sessions.length
  t.ok(sessionsFinal > sessionsAfter)
})

test('passive replication does not leak any sessions', async function (t) {
  const store1 = new Corestore(ram.reusable())
  const store2 = new Corestore(ram.reusable())

  const a = store1.get({ name: 'a' })
  await a.append('hello')
  const key = a.key
  await a.close()

  t.is(store1.cores.size, 0)

  const s1 = store1.replicate(true)
  const s2 = store2.replicate(false)
  s1.pipe(s2).pipe(s1)

  const b = store2.get({ key })
  await b.get(0) // ensure replication

  t.is(store1.cores.size, 1)

  s1.destroy()
  s2.destroy()

  await new Promise(resolve => setImmediate(resolve))

  t.is(store1.cores.size, 0)

  await b.close()
})

test('replication sessions auto close when inactive', async function (t) {
  const store1 = new Corestore(ram.reusable())
  const store2 = new Corestore(ram.reusable())

  const a = store1.get({ name: 'a' })

  await a.append('testing 1')
  await a.append('testing 2')
  await a.append('testing 3')

  const s1 = store1.replicate(true)
  const s2 = store2.replicate(false)
  s1.pipe(s2).pipe(s1)

  await a.ready()
  const b = store2.get({ key: a.key })

  t.alike(await b.get(0), Buffer.from('testing 1'))

  await a.close()
  await b.close()

  await new Promise(resolve => setImmediate(resolve))

  t.is(store1.cores.size, 0, 'gced all')
  t.is(store2.cores.size, 0, 'gced all')

  const c = store2.get({ key: a.key })

  t.alike(await c.get(1), Buffer.from('testing 2'), 're-replication still works')

  await c.close()

  const d = store2.get({ key: a.key })

  t.alike(await d.get(2), Buffer.from('testing 3'), 're-replication still works')
})

function replicate (t, store1, store2) {
  const s1 = store1.replicate(true)
  const s2 = store2.replicate(false)

  s1.pipe(s2).pipe(s1)

  const wait = new Promise(resolve => {
    let missing = 2

    s1.on('error', noop)
    s2.on('error', noop)
    s1.on('close', done)
    s2.on('close', done)

    function done () {
      if (--missing === 0) resolve()
    }
  })

  t.teardown(() => {
    s1.destroy()
    s2.destroy()
    return wait
  })

  return [s1, s2]
}

function noop () {}
