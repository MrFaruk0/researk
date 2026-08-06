export const VERSION = "0.0.0";

export const HELP = `Researk ${VERSION} (pre-alpha)

Usage:
  researk                         Start the interactive research REPL on a TTY
  researk help                    Show command help
  researk version                 Show the CLI version
  researk models [options]        List configured provider models
  researk chat [options] PROMPT   Stream one Harness chat run
  researk doctor [options]        Inspect local CLI capabilities

Options:
  --model provider:model          Required explicit model identity for chat
  --reasoning INTENT              auto|off|minimal|low|medium|high|xhigh
  --provider-id ID                OpenAI-compatible provider identity
  --base-url URL                  OpenAI-compatible endpoint
  --api-key-env NAME              Environment variable reference (never printed)
  --raw                           Exact-source, undecorated response mode
  --json                          JSON Lines event mode
  --help, -h                      Show this help
  --version, -v                   Show the version

No credentials are stored. Configure secrets only in the referenced environment variable.
`;

export const REPL_HELP = `/models                 List configured models
/model provider:model    Select an explicit model
/reasoning INTENT        Set reasoning intent
/status                  Show provider:model and reasoning status
/help                    Show this help
/exit                    Exit the REPL
Ctrl-C                   Cancel the active run without exiting
`;
