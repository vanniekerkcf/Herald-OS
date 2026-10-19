import { describe, expect, it } from 'vitest'
import { describeTool, hostOf, nameOf, roomToolCall } from './areas.ts'

const step = (name: string, args: Record<string, unknown> = {}, labels: unknown = null, context?: Parameters<typeof describeTool>[1]) => describeTool(roomToolCall(name, args, labels), context)

describe('targets are names, never content', () => {
  it("keeps a file's last path segment", () => {
    expect(nameOf('/Users/me/Work/Budget.xlsx')).toBe('Budget.xlsx')
    expect(nameOf('~/Projects/site/')).toBe('site')
    expect(nameOf('C:\\Users\\me\\notes.txt')).toBe('notes.txt')
    expect(nameOf('file:///tmp/report.pdf?x=1')).toBe('report.pdf')
    expect(nameOf('~')).toBeNull()
    expect(nameOf('')).toBeNull()
    expect(nameOf(42)).toBeNull()
  })

  it("keeps a web address's host and port, without credentials, path or query", () => {
    expect(hostOf('https://user:pw@example.com/a?b')).toBe('example.com')
    expect(hostOf('http://localhost:5173/app')).toBe('localhost:5173')
    expect(hostOf('Booking.com/hotels?city=Rome')).toBe('booking.com')
    expect(hostOf('not a url at all')).toBeNull()
  })

  it('cuts long names to about 40 characters', () => {
    const name = nameOf(`/tmp/${'a'.repeat(60)}.md`)!

    expect(name.length).toBeLessThanOrEqual(40)
    expect(name.endsWith('…')).toBe(true)
  })

  it('reads Hermes target keys and nothing else', () => {
    expect(roomToolCall('write_file', { path: '/secret/dir/plan.md', content: 'the whole plan' }, null)).toEqual({ name: 'write_file', target: 'plan.md', folder: null, action: null, command: null, app: null })
    expect(roomToolCall('web_extract', { urls: ['https://a:b@news.example.org/story?id=1'] }, null).target).toBe('news.example.org')
    expect(roomToolCall('search_files', { pattern: 'password', path: '/home/me/src' }, null).target).toBe('src')
  })

  it('never takes a command text as the terminal target, only its folder', () => {
    const call = roomToolCall('terminal', { command: 'rm -rf /tmp/secret', workdir: '/home/me/herald' }, null)

    expect(call.target).toBeNull()
    expect(call.folder).toBe('herald')
    expect(describeTool(call)).toEqual({ area: 'terminal', target: 'herald', step: 'running a command' })
    expect(step('terminal', { command: 'ls' }, null, { cwd: 'Hermes-OS', area: null, target: null })).toEqual({ area: 'terminal', target: 'Hermes-OS', step: 'running a command' })
  })

  it('drops action words and commands that are not plain identifiers', () => {
    expect(roomToolCall('os_ui', { action: 'run', command: 'rm -rf / && echo' }, null).command).toBeNull()
  })
})

describe('the area table', () => {
  it('puts file tools in the files area', () => {
    expect(step('read_file', { path: '/x/Budget.xlsx' })).toEqual({ area: 'files', target: 'Budget.xlsx', step: 'reading Budget.xlsx' })
    expect(step('read_file')).toEqual({ area: 'files', target: null, step: 'reading a file' })
    expect(step('write_file', { path: 'a/b.txt' }).step).toBe('writing b.txt')
    expect(step('patch', { path: 'src/app.ts' }).step).toBe('editing app.ts')
    expect(step('search_files').step).toBe('searching files')
    expect(step('system_files').step).toBe('organising files')
    expect(step('system_find_files').step).toBe('searching for files')
    expect(step('system_documents').step).toBe('looking through documents')
    expect(step('vision_analyze', { image_url: 'https://x.test/a.png' })).toEqual({ area: 'files', target: null, step: 'looking at an image' })
  })

  it('puts commands, processes and system checks in the terminal area', () => {
    expect(step('process_manage')).toMatchObject({ area: 'terminal', step: 'managing a process' })
    expect(step('process')).toMatchObject({ area: 'terminal', step: 'managing a process' })

    for (const name of ['system_info', 'system_processes', 'system_disk_usage', 'system_network', 'system_logs', 'system_os', 'system_control']) {
      expect(step(name)).toMatchObject({ area: 'terminal', step: 'checking the system' })
    }

    expect(step('system_kill_process')).toMatchObject({ area: 'terminal', step: 'stopping a process' })
  })

  it('puts code in the studio and the web in the browser', () => {
    expect(step('execute_code', { code: 'print(1)' })).toEqual({ area: 'studio', target: null, step: 'running code' })
    expect(step('web_search', { query: 'hotels in Rome' })).toEqual({ area: 'browser', target: null, step: 'searching the web' })
    expect(step('web_extract', { urls: ['https://booking.com/x'] }).step).toBe('reading booking.com')
    expect(step('browser_navigate', { url: 'https://www.booking.com/rome' }).step).toBe('browsing www.booking.com')
    expect(step('browser_click', { ref: '@e3' }).step).toBe('browsing the web')
  })

  it('keeps the host the browser is on for calls that name none', () => {
    expect(step('browser_click', { ref: '@e3' }, null, { cwd: null, area: 'browser', target: 'booking.com' })).toEqual({ area: 'browser', target: 'booking.com', step: 'browsing booking.com' })
    expect(step('browser_click', {}, null, { cwd: null, area: 'files', target: 'a.txt' }).step).toBe('browsing the web')
  })

  it('names Office documents, or the one in front', () => {
    expect(step('docs', { action: 'write', document: '~/Letters/Offer.docx', content: 'Dear…' })).toEqual({ area: 'docs', target: 'Offer.docx', step: 'working on Offer.docx', front: false })
    expect(step('docs', { action: 'read' })).toEqual({ area: 'docs', target: null, step: 'reading the document in front', front: true })
    expect(step('sheets', { action: 'read', workbook: 'Budget.xlsx' }).step).toBe('reading Budget.xlsx')
    expect(step('sheets', { action: 'list_charts', workbook: 'Budget.xlsx' }).step).toBe('reading Budget.xlsx')
    expect(step('sheets', { action: 'fill' }).step).toBe('working on the workbook in front')
    expect(step('slides', { action: 'add_slide', presentation: 'Pitch.pptx' })).toMatchObject({ area: 'slides', step: 'working on Pitch.pptx' })
    expect(step('docs', { action: 'list' })).toEqual({ area: 'docs', target: null, step: 'looking at Herald Docs' })
  })

  it('puts images in the canvas area', () => {
    expect(step('canvas', { action: 'add_text', project: '~/Art/poster.comp' })).toEqual({ area: 'canvas', target: 'poster.comp', step: 'working on poster.comp', front: false })
    expect(step('canvas', { action: 'preview' })).toMatchObject({ step: 'working on the image in front', front: true })
    expect(step('image_generate', { prompt: 'a cat' })).toEqual({ area: 'canvas', target: null, step: 'making an image' })
  })

  it('puts memory and skills in the memory area', () => {
    expect(step('memory', { action: 'add', content: 'likes tea' })).toMatchObject({ area: 'memory', step: 'updating memory' })
    expect(step('session_search', { query: 'invoices' }).step).toBe('searching past conversations')
    expect(step('skill_view').step).toBe('reading a skill')
    expect(step('skills_list').step).toBe('looking at skills')
    expect(step('skill_manage').step).toBe('updating a skill')
  })

  it('puts messages, connections and connector apps in the messages area', () => {
    expect(step('send_message', { message: 'hi' })).toMatchObject({ area: 'messages', step: 'sending a message' })
    expect(step('manage_connections')).toMatchObject({ area: 'messages', step: 'managing connections' })
    expect(step('tool_call', { name: 'gmail_send' }, [{ kind: 'connector', app: 'Gmail', action: 'send', emoji: '📧', text: 'Send an email to the team', name: 'gmail_send' }])).toEqual({
      area: 'messages',
      target: 'Gmail',
      step: 'using Gmail'
    })
    expect(step('mcp_github_create_issue', {}, [{ kind: 'mcp', app: 'GitHub', action: 'create', emoji: '', text: '', name: 'create_issue' }]).step).toBe('using GitHub')
  })

  it('describes a bridged call by the inner tool its labels name', () => {
    expect(step('tool_call', { name: 'read_file', arguments: { path: '/x/y.txt' } }, [{ kind: 'tool', app: '', action: '', emoji: '', text: 'Read y.txt', name: 'read_file' }])).toEqual({ area: 'files', target: null, step: 'reading a file' })
  })

  it("maps Herald's own commands by their app", () => {
    expect(step('os_ui', { action: 'run', command: 'docs.open' })).toEqual({ area: 'docs', target: null, step: 'opening Herald Docs' })
    expect(step('os_ui', { action: 'run', command: 'sheets.set_cell' })).toEqual({ area: 'sheets', target: null, step: 'using Herald' })
    expect(step('os_ui', { action: 'run', command: 'web.open' })).toMatchObject({ area: 'browser', step: 'opening the browser' })
    expect(step('os_ui', { action: 'run', command: 'connections.list' })).toMatchObject({ area: 'messages', step: 'using Herald' })
    expect(step('os_ui', { action: 'run', command: 'page.open' })).toEqual({ area: null, target: null, step: 'using Herald' })
    expect(step('os_ui', { action: 'list' })).toEqual({ area: null, target: null, step: 'looking at Herald' })
    expect(step('os_ui', { action: 'state' })).toEqual({ area: null, target: null, step: 'looking at Herald' })
  })

  it('leaves the area alone for planning, delegating, scheduling and unknown tools', () => {
    expect(step('todo', { todos: [{ content: 'buy milk' }] })).toEqual({ area: null, target: null, step: 'updating the plan' })
    expect(step('todo_list').step).toBe('updating the plan')
    expect(step('delegate_task', { goal: 'Find hotels' })).toEqual({ area: null, target: null, step: 'handing work to a helper' })
    expect(step('cronjob_manage').step).toBe('scheduling an automation')
    expect(step('computer_use').step).toBe('using the computer')
    expect(step('weather_lookup_v2', { city: 'Rome' })).toEqual({ area: null, target: null, step: 'using weather lookup v2' })
  })

  it('sends clarify to the bench', () => {
    expect(step('clarify', { question: 'Which one?' })).toEqual({ area: 'bench', target: null, step: 'waiting for you in Hermes' })
  })

  it('opens what system_open names', () => {
    expect(step('system_open', { target: 'url', url: 'https://maps.example.com/x' })).toEqual({ area: 'browser', target: 'maps.example.com', step: 'opening maps.example.com' })
    expect(step('system_open', { target: 'path', path: '/Users/me/Report.pdf' })).toEqual({ area: 'files', target: 'Report.pdf', step: 'opening Report.pdf' })
    expect(step('system_open', { target: 'app', app: 'Safari' })).toEqual({ area: null, target: 'Safari', step: 'opening Safari' })
    expect(step('system_open', { target: 'settings', pane: 'wifi' })).toEqual({ area: null, target: null, step: 'opening Settings' })
  })
})
