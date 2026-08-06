export const VERSION = "0.1.0-alpha.1";

export const HELP = `Researk ${VERSION} (pre-alpha)

Usage:
  researk                         Open the current directory as a local workspace
  researk help                    Show command help
  researk version                 Show the CLI version
  researk models [options]        List models from a configured provider
  researk chat [options] PROMPT   Stream one Harness chat run
  researk doctor [options]        Inspect local CLI capabilities

Options:
  --model provider:model          Explicit model identity for chat
  --reasoning INTENT              auto|off|minimal|low|medium|high|xhigh
  --provider-id ID                openrouter or a custom compatible provider identity
  --base-url URL                  Custom compatible endpoint (or OpenRouter override)
  --api-key-env NAME              Credential environment-variable reference; never printed
  --raw                           Exact-source, undecorated response mode
  --json                          JSON Lines event mode
  --help, -h                      Show this help
  --version, -v                   Show the version

Examples:
  researk
  researk models --provider-id openrouter --api-key-env OPENROUTER_API_KEY
  researk chat --model openrouter:provider/model --reasoning auto "Summarize this result"

No credentials are stored. Provider and document transmission is explicit in the interactive CLI.
`;

export const REPL_HELP = `Workspace commands:
  /provider                         Show provider connection help
  /provider openrouter [ENV] [URL]  Connect the OpenRouter profile
  /provider compatible ID URL [ENV] Connect a custom OpenAI-compatible provider
  /models                           Refresh and list the connected provider catalog
  /model provider:model             Select an available catalog model
  /reasoning [INTENT]               List or set a selected model's advertised reasoning intents
  /read <relative-path>             Stage a bounded UTF-8 .txt/.md/.tex/.bib document for one prompt
  /status                           Show workspace, connection, selection, history, and staged data
  /theme [NAME]                     List or select system, dark, light, high-contrast, or mono
  /help                             Show this help
  /exit                             Exit the REPL

A staged document remains local until the next prompt. That one prompt sends it as untrusted
reference data to the selected provider, then consumes the staged copy. The REPL never executes
document content. Conversation history is memory-only for this process and is bounded.
Ctrl-C cancels an active run without exiting.
`;
