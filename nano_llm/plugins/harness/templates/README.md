# Adding your own tools and skills

The agent presets (`AgentLoop` → `Tools_Hub` / `Skills_Hub`) can be extended without changing Edge Agent itself:

| You want the agent to… | Add a | Example |
|---|---|---|
| **do** something new: read a sensor, call a service, control a device | **tool** (a Python function) | `get_disk_usage` in `my_tool.py.example` |
| **use the tools it has better** for one kind of request: the steps, the order, the usual mistakes | **skill** (a `SKILL.md` file) | `SKILL.md.example` |

A skill adds no ability: it is instructions. If the agent cannot do the job with the tools it has, write a tool.

The two templates in this folder end in `.example`, so Edge Agent ignores them where they are.

## Add a tool

1. Copy the template into the tools folder, under a name that ends in `.py` and does not start with `_`:
   ```bash
   cp nano_llm/plugins/harness/templates/my_tool.py.example nano_llm/plugins/harness/tools/disk_usage.py
   ```
2. Edit the copy: rename the function (the function name is the tool name), write its docstring, and register it with `register_tool(...)` at the end of the file.
3. Load the preset again in Studio (**Agent → Load**). `Tools_Hub` loads every tool file in `nano_llm/plugins/harness/tools/` when it starts.
4. Open `Tools_Hub` (double-click it): the new tool is listed and **switched on in every agent preset**. Untick it in the presets that should not have it.
5. Ask the agent something the tool answers, for example "How much space is left on /data?". The chat panel shows a card for each tool call with its result.

### What the model sees

The model chooses a tool only from its name, its docstring and its arguments:

- **Docstring, first part**: what the tool does, when to use it, and what it cannot do.
- **`Args:`**: one line for each argument. Each argument needs a type annotation (`str`, `int`, `float` or `bool`). An argument with a default value is optional.
- **Return** `ToolOutput(text=...)`. A tool can also return images: `ToolOutput(text=..., images=[pil_image])`.
- **Raise** `ToolError("...")` for an expected failure (a wrong path, a device that is not connected). The message goes back to the model, which can try again or tell the user. Any other exception is reported as a tool error too, and the conversation goes on.

### `register_tool` settings

| Setting | Meaning |
|---|---|
| `risk="low"` | runs at once |
| `risk="high"` | waits for **Confirm** / **Deny** / **Allow for this conversation** in the chat panel. Use it for tools that write, delete, move hardware or run commands. The preset needs a `SafetyReview` node, or the call is denied. |
| `refetchable=True` | calling it again gives the same kind of answer, so an old result may be dropped when a long conversation is compacted |
| `parallel_safe=True` | it only reads, so it may run at the same time as other tool calls |

A tool call stops after 120 seconds (`AgentLoop` **Tool Timeout**). Keep a tool shorter than that.

## Add a skill

1. Create a folder for the skill and copy the template into it as `SKILL.md`:
   ```bash
   mkdir nano_llm/plugins/harness/skills/check_storage
   cp nano_llm/plugins/harness/templates/SKILL.md.example nano_llm/plugins/harness/skills/check_storage/SKILL.md
   ```
2. Edit the copy:
   - **`name`**: the folder name;
   - **`description`**: one or two sentences. This is the only part that is always in the model's prompt, so say which requests the skill is for;
   - **the body**: the steps. The model reads it when it calls `load_skill`.
3. Other files in the skill folder (examples, tables) are listed for the model, which reads them with `read_file` when the steps say so. `read_file` must be switched on in `Tools_Hub`.
4. Load the preset again. The skill is listed and switched on in `Skills_Hub` (double-click it).

## Tips

- Change one thing at a time and try the same questions before and after.
- Write docstrings and skills in English or in the language of your users. The model answers in the language that the `AgentLoop` system prompt asks for.
- A tool that the model calls at the wrong time usually needs a clearer docstring ("Use it when…", "It does not…"), not a longer system prompt.
- Copies you add are your files: keep them when you update Edge Agent with `git pull`.
