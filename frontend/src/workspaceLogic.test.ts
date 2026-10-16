import test from 'node:test'
import assert from 'node:assert/strict'

import {
  accountCanGenerate,
  buildTemplateDraft,
  documentTitleForProfession,
  isLatestSessionResponse,
  mergeLockedSections,
  safeStorageGet,
  safeStorageRemove,
  safeStorageSet,
  validProfessionChoice,
} from './workspaceLogic.ts'

const founderTemplate = {
  id: 'founder_meeting_notes',
  name: 'Meeting Notes — Founder',
  sections: [
    { id: 'attendees', label: 'Attendees' },
    { id: 'decisions', label: 'Decisions' },
    { id: 'owners', label: 'Owners' },
  ],
}

test('immediate draft preserves selected template section identity', () => {
  const draft = buildTemplateDraft(founderTemplate, 'Adebayo attended. Decided to ship. Folake owns launch.')
  assert.deepEqual(draft.sections.map(section => section.id), ['attendees', 'decisions', 'owners'])
  assert.equal(draft.template_id, 'founder_meeting_notes')
  assert.equal(draft.title, 'Meeting Notes — Founder')
})

test('locked sections survive even when a generated result omits them', () => {
  const current = {
    ...buildTemplateDraft(founderTemplate, ''),
    sections: founderTemplate.sections.map(section => ({ ...section, content: section.id === 'owners' ? 'USER OWNER' : '' })),
  }
  const generated = {
    ...current,
    sections: [{ id: 'decisions', label: 'Decisions', content: 'Ship' }],
  }
  const merged = mergeLockedSections(current, generated, new Set(['owners']))
  assert.equal(merged.sections.find(section => section.id === 'owners')?.content, 'USER OWNER')
})

test('authenticated account entitlement bypasses guest-local usage', () => {
  assert.equal(accountCanGenerate({ authenticated: true, plan: 'pro', usage: { used: 99, limit: null } }), true)
  assert.equal(accountCanGenerate({ authenticated: true, plan: 'free', usage: { used: 3, limit: 10 } }), true)
  assert.equal(accountCanGenerate({ authenticated: true, plan: 'free', usage: { used: 10, limit: 10 } }), false)
})

test('only the latest session response may update account state', () => {
  assert.equal(isLatestSessionResponse(4, 4), true)
  assert.equal(isLatestSessionResponse(3, 4), false)
})

test('storage helpers fail closed without interrupting onboarding', () => {
  const blocked = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  assert.equal(safeStorageGet(blocked, 'key'), null)
  assert.equal(safeStorageSet(blocked, 'key', 'value'), false)
  assert.equal(safeStorageRemove(blocked, 'key'), false)
})

test('onboarding completion requires a concrete profession', () => {
  assert.equal(validProfessionChoice('', ''), false)
  assert.equal(validProfessionChoice('__custom__', ''), false)
  assert.equal(validProfessionChoice('__custom__', 'Engineer'), true)
  assert.equal(validProfessionChoice('doctor', ''), true)
})

test('generic local-model prompts use the generic document title', () => {
  assert.equal(documentTitleForProfession('doctor'), 'Clinical Note')
  assert.equal(documentTitleForProfession('lawyer'), 'Case Note')
  assert.equal(documentTitleForProfession('founder'), 'Professional Document')
})
