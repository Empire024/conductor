import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_DOLPHIN_X1_8B } from '../../shared/local-models.ts'

/** Chat-template variables sent with every local request (llama.cpp `chat_template_kwargs`).
 *
 *  Measured 2026-09-25 on Dolphin X1 8B, whose GGUF embeds the stock Llama 3.1 template:
 *  - `date_string` defaults to "26 Jul 2024", so the model was told it was mid-2024 and answered
 *    "latest" questions with 2022-era facts and no reason to search.
 *  - `tools_in_user_message` defaults to true, which rewrites the owner's first message as "Given
 *    the following functions, please respond with a JSON for a function call ... that best answers
 *    the given prompt". Every plain question then became a run_command (0 of 9 owner-style
 *    questions answered). False puts the same schemas in the system message instead, where they
 *    are offered rather than demanded.
 *  A template that does not use a variable ignores it, so Qwen and Ornith are unaffected. */
export function templateKwargs(now = new Date()): Record<string, unknown> {
  return { date_string: templateDate(now), tools_in_user_message: false }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The Llama 3.1 template's own format, "26 Jul 2024", in local time: the owner's today. */
export const templateDate = (now: Date): string => `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`

/** The date as the system prompt states it to every model, ISO so no model misreads it. */
export const promptDate = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

/** Dolphin X1 8B's embedded Llama 3.1 template with three changes, each measured on the owner's
 *  question set (docs/local-model-dolphin-x1-8b.md):
 *  - no "Environment: ipython" line. It switches Llama 3.1 into code-interpreter mode, and with
 *    tools offered Dolphin answered "how many grams is a cup of butter" with a Python block.
 *  - tools in the system message, offered rather than demanded, with "call one only when you need
 *    it; otherwise answer directly".
 *  - tool calls written and shown back as {"name", "arguments"}, which is what the fine-tune
 *    writes. llama.cpp derives its tool-call parser from how the template renders a call, so the
 *    stock template's "parameters" made every call Dolphin wrote under tool_choice auto arrive
 *    as a one-character stub; with this one the server parses them.
 *  Sent by Conductor itself with --chat-template-file (llama.ts); an owner's extraArgs still may
 *  not name a template file. */
export const DOLPHIN_TEMPLATE = String.raw`{{- bos_token }}
{%- if not date_string is defined %}
    {%- set date_string = "26 Jul 2024" %}
{%- endif %}
{%- if not tools is defined %}
    {%- set tools = none %}
{%- endif %}
{%- if messages[0]['role'] == 'system' %}
    {%- set system_message = messages[0]['content']|trim %}
    {%- set messages = messages[1:] %}
{%- else %}
    {%- set system_message = "" %}
{%- endif %}
{{- "<|start_header_id|>system<|end_header_id|>\n\n" }}
{{- "Cutting Knowledge Date: December 2023\n" }}
{{- "Today Date: " + date_string + "\n\n" }}
{%- if tools is not none %}
    {{- "You have access to the following functions. Call one only when you need it; otherwise answer the user directly in plain text. To call a function, respond with only a JSON object in the format {\"name\": function name, \"arguments\": dictionary of argument name and its value}. Do not use variables.\n\n" }}
    {%- for t in tools %}
        {{- t | tojson(indent=4) }}
        {{- "\n\n" }}
    {%- endfor %}
{%- endif %}
{{- system_message }}
{{- "<|eot_id|>" }}
{%- for message in messages %}
    {%- if not (message.role == 'ipython' or message.role == 'tool' or 'tool_calls' in message) %}
        {{- '<|start_header_id|>' + message['role'] + '<|end_header_id|>\n\n'+ message['content'] | trim + '<|eot_id|>' }}
    {%- elif 'tool_calls' in message %}
        {%- set tool_call = message.tool_calls[0].function %}
        {{- '<|start_header_id|>assistant<|end_header_id|>\n\n' -}}
        {{- '{"name": "' + tool_call.name + '", ' }}
        {{- '"arguments": ' }}
        {{- tool_call.arguments | tojson }}
        {{- "}" }}
        {{- "<|eot_id|>" }}
    {%- elif message.role == "tool" or message.role == "ipython" %}
        {{- "<|start_header_id|>ipython<|end_header_id|>\n\n" }}
        {%- if message.content is mapping or message.content is iterable %}
            {{- message.content | tojson }}
        {%- else %}
            {{- message.content }}
        {%- endif %}
        {{- "<|eot_id|>" }}
    {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
    {{- '<|start_header_id|>assistant<|end_header_id|>\n\n' }}
{%- endif %}
`

/** Conductor's own chat templates, by model id. A model not listed keeps its embedded one. */
export const CHAT_TEMPLATES: Readonly<Record<string, string>> = { [LOCAL_DOLPHIN_X1_8B]: DOLPHIN_TEMPLATE }

/** Writes the model's Conductor template into `dir` and returns its path, or undefined for a
 *  model that keeps its own. Rewritten on every start, so an update's template always wins. */
export function writeChatTemplate(modelId: string, dir: string): string | undefined {
  const template = CHAT_TEMPLATES[modelId]
  if (!template) return undefined
  mkdirSync(dir, { recursive: true })
  const path = join(dir, modelId.replace(/[^a-z0-9.-]/gi, '_') + '.jinja')
  writeFileSync(path, template, 'utf8')
  return path
}
