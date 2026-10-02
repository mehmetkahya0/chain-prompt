import type { ChainFile } from './types'

// Built-in chain templates, offered in the Templates dialog.
const NO_QUESTIONS = 'Do not ask me questions; make reasonable assumptions and note them.'

export const BUILTIN_TEMPLATES: (ChainFile & { name: string; description: string })[] = [
  {
    format: 'chain-prompt',
    version: 2,
    name: 'Feature workflow',
    description: 'Plan, implement, test until green, review with fresh eyes, changelog.',
    variables: [{ name: 'feature', description: 'What to build' }],
    steps: [
      { prompt: `Write an implementation plan for this feature to PLAN.md: {{feature}}\nDo not change code yet. ${NO_QUESTIONS}` },
      { prompt: `Implement PLAN.md. ${NO_QUESTIONS}` },
      {
        prompt: 'Run the test suite and fix anything that fails.',
        verify: 'npm test',
        fixPrompt: 'The tests still fail:\n\n{{verify.output}}\n\nFix the cause, not the tests.',
        maxLoops: 3
      },
      { prompt: 'Review the diff of this work with fresh eyes and fix what you find.', newSession: true },
      { prompt: 'Write a concise CHANGELOG entry for the work above.' }
    ]
  },
  {
    format: 'chain-prompt',
    version: 2,
    name: 'Fix a bug',
    description: 'Reproduce with a failing test, fix, verify, summarize.',
    variables: [{ name: 'bug', description: 'Bug description or issue text' }],
    steps: [
      { prompt: `Investigate this bug and write a failing test that reproduces it. Do not fix it yet.\n\n{{bug}}\n\n${NO_QUESTIONS}` },
      {
        prompt: 'Fix the bug so the new test passes without breaking other tests.',
        verify: 'npm test',
        fixPrompt: 'Tests are failing:\n\n{{verify.output}}\n\nKeep going until they pass.',
        maxLoops: 3
      },
      { prompt: 'Summarize the root cause and the fix in 5 lines or fewer.' }
    ]
  },
  {
    format: 'chain-prompt',
    version: 2,
    name: 'Refactor',
    description: 'Map the code, refactor in small steps, keep tests green.',
    variables: [{ name: 'target', description: 'What to refactor (file, module, pattern)' }],
    steps: [
      { prompt: `Read {{target}} and list concrete refactoring opportunities in REFACTOR.md, ordered by value. ${NO_QUESTIONS}` },
      {
        prompt: 'Apply the refactorings from REFACTOR.md one at a time. Behaviour must not change.',
        verify: 'npm test',
        fixPrompt: 'The refactor broke tests:\n\n{{verify.output}}\n\nFix them without changing behaviour.',
        maxLoops: 3
      },
      { prompt: 'Review the refactor with fresh eyes for accidental behaviour changes and fix them.', newSession: true }
    ]
  },
  {
    format: 'chain-prompt',
    version: 2,
    name: 'Write tests',
    description: 'Find untested code, add tests, make them pass.',
    variables: [{ name: 'area', description: 'Area to cover (folder or module)' }],
    steps: [
      { prompt: `Find the most important untested behaviour in {{area}} and list it in TESTPLAN.md. ${NO_QUESTIONS}` },
      {
        prompt: 'Write tests for everything in TESTPLAN.md, following the existing test style.',
        verify: 'npm test',
        fixPrompt: 'Some tests fail:\n\n{{verify.output}}\n\nFix the tests (or the code, if it is really a bug and say so).',
        maxLoops: 3
      }
    ]
  },
  {
    format: 'chain-prompt',
    version: 2,
    name: 'Security review',
    description: 'Review for vulnerabilities, fix the real ones, report.',
    steps: [
      { prompt: `Do a security review of this repository. Write findings with severity and file:line to SECURITY_REVIEW.md. ${NO_QUESTIONS}` },
      { prompt: 'Fix every High and Critical finding from SECURITY_REVIEW.md and mark them fixed there.' },
      { prompt: 'Re-check the fixes with fresh eyes; update SECURITY_REVIEW.md with anything still open.', newSession: true }
    ]
  },
  {
    format: 'chain-prompt',
    version: 2,
    name: 'Prepare a pull request',
    description: 'Clean up, test, write the PR description.',
    steps: [
      { prompt: 'Remove debug code, stray TODOs and dead code introduced on this branch.' },
      {
        prompt: 'Run lint and tests and fix what fails.',
        verify: 'npm test',
        fixPrompt: 'Still failing:\n\n{{verify.output}}',
        maxLoops: 2
      },
      { prompt: 'Write a pull request description for this branch to PR.md: summary, changes, how to test.' }
    ]
  },
  {
    format: 'chain-prompt',
    version: 2,
    name: 'Update docs',
    description: 'Bring README and docs in line with the code.',
    steps: [
      { prompt: `Compare README.md and docs/ with the actual code and list what is outdated or missing. ${NO_QUESTIONS}` },
      { prompt: 'Update the documentation to fix everything you listed. Keep the existing tone.' }
    ]
  }
]
