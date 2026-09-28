import { describe, expect, it } from 'vitest'

import { classifyChange, compareReports } from '../src/commands/diff.js'

type Check = {
  id: string
  title: string
  status: 'pass' | 'warn' | 'fail' | 'skip'
  message: string
}

function check(id: string, status: Check['status'], title = id): Check {
  return { id, title, status, message: `${id} is ${status}` }
}

describe('classifyChange', () => {
  it('ignores an unchanged pass', () => {
    expect(
      classifyChange(check('dns', 'pass'), check('dns', 'pass')),
    ).toBeNull()
  })

  it('keeps an unchanged problem', () => {
    const change = classifyChange(check('dns', 'fail'), check('dns', 'fail'))
    expect(change?.kind).toBe('still-broken')
  })

  it('reports a fixed warning', () => {
    const change = classifyChange(
      check('git-prereqs', 'warn'),
      check('git-prereqs', 'pass'),
    )
    expect(change?.kind).toBe('fixed')
    expect(change?.from).toBe('warn')
    expect(change?.to).toBe('pass')
  })

  it('reports a regression', () => {
    const change = classifyChange(
      check('storage', 'pass'),
      check('storage', 'fail'),
    )
    expect(change?.kind).toBe('regressed')
  })

  it('reports a check that is newly reporting a problem', () => {
    const change = classifyChange(null, check('proxy-trust', 'warn'))
    expect(change?.kind).toBe('new-check')
    expect(change?.from).toBeNull()
  })

  it('ignores a check that is new but healthy', () => {
    expect(classifyChange(null, check('tls-chain', 'pass'))).toBeNull()
  })

  it('reports a check that disappeared while it was a problem', () => {
    const change = classifyChange(check('stale-lock', 'warn'), null)
    expect(change?.kind).toBe('resolved-away')
    expect(change?.to).toBeNull()
  })

  it('ignores a check that disappeared while it was healthy', () => {
    expect(classifyChange(check('dns', 'pass'), null)).toBeNull()
  })

  it('treats warn to fail as a regression, not a fix', () => {
    const change = classifyChange(
      check('storage', 'warn'),
      check('storage', 'fail'),
    )
    expect(change?.kind).toBe('regressed')
  })

  it('treats skip to fail as a regression', () => {
    const change = classifyChange(check('dns', 'skip'), check('dns', 'fail'))
    expect(change?.kind).toBe('regressed')
  })
})

describe('compareReports', () => {
  const before = {
    summary: { total: 2, pass: 0, warn: 1, fail: 1, skip: 0 },
    checks: [check('dns', 'fail'), check('git-prereqs', 'warn')],
  }

  const after = {
    summary: { total: 3, pass: 2, warn: 0, fail: 1, skip: 0 },
    checks: [
      check('dns', 'fail'),
      check('git-prereqs', 'pass'),
      check('proxy-trust', 'fail'),
    ],
  }

  it('summarises fixes, regressions and outstanding problems', () => {
    const changes = compareReports(before, after)
    expect(changes.map((change) => change.id)).toEqual([
      'git-prereqs',
      'proxy-trust',
      'dns',
    ])
    expect(changes.map((change) => change.kind)).toEqual([
      'fixed',
      'new-check',
      'still-broken',
    ])
  })

  it('still lists outstanding problems when the reports agree', () => {
    const changes = compareReports(before, before)
    expect(changes.map((change) => change.id)).toEqual(['dns', 'git-prereqs'])
    expect(changes.every((change) => change.kind === 'still-broken')).toBe(true)
  })

  it('copes with reports that hold no checks', () => {
    expect(compareReports({}, {})).toEqual([])
    // Both problems are new, so they keep the order the report lists them in.
    expect(compareReports({}, after).map((change) => change.id)).toEqual([
      'dns',
      'proxy-trust',
    ])
  })
})
