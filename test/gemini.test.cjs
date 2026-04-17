const test = require('node:test')
const assert = require('node:assert/strict')

const { geminiGenerate } = require('../out-test/gemini.js')

test('geminiGenerate posts the expected request body and returns response text', async () => {
  const calls = []
  global.fetch = async (url, options) => {
    calls.push({ url, options })
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [{ text: 'Generated result' }]
              }
            }
          ]
        }
      }
    }
  }

  const result = await geminiGenerate('test-key', 'System prompt', 'User prompt', {
    model: 'gemini-custom',
    responseMimeType: 'application/json',
    maxTokens: 2048
  })

  assert.equal(result, 'Generated result')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-custom:generateContent')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'test-key')

  const body = JSON.parse(calls[0].options.body)
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'System prompt' }] },
    { role: 'model', parts: [{ text: 'Understood.' }] },
    { role: 'user', parts: [{ text: 'User prompt' }] }
  ])
  assert.equal(body.generationConfig.maxOutputTokens, 2048)
  assert.equal(body.generationConfig.responseMimeType, 'application/json')
})

test('geminiGenerate surfaces API failures with status and body text', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 429,
    async text() {
      return 'rate limited'
    }
  })

  await assert.rejects(
    geminiGenerate('test-key', 'System prompt', 'User prompt'),
    /Gemini API error 429: rate limited/
  )
})

test('geminiGenerate rejects responses that do not contain candidate text', async () => {
  global.fetch = async () => ({
    ok: true,
    async json() {
      return { candidates: [] }
    }
  })

  await assert.rejects(
    geminiGenerate('test-key', 'System prompt', 'User prompt'),
    /No text in Gemini response/
  )
})
