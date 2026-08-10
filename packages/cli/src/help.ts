export const VERSION = "0.1.0-alpha.4";

export const HELP = `Researk ${VERSION} (pre-alpha)

Usage:
  researk                         Open the full-screen workspace UI in the current directory
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
  --accessible                    Disable graphics and styling; preserve linear exact source
  --json                          JSON Lines event mode
  --help, -h                      Show this help
  --version, -v                   Show the version

Examples:
  researk
  researk models --provider-id openrouter --api-key-env OPENROUTER_API_KEY
  researk chat --model openrouter:provider/model --reasoning auto "Summarize this result"

Provider profiles, sessions, and TUI configuration persist locally. API keys remain in memory and must be supplied through supported environment-variable references until an OS credential backend exists. One-shot commands never store credentials.
`;
