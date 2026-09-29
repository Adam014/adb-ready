# Shell completion

ADB Ready generates static tab-completion scripts for both `adb-ready` and its
short alias, `adbr`. Generation is instant and offline: it does not load project
configuration, start ADB, or inspect a device.

## Bash

```bash
mkdir -p ~/.local/share/bash-completion/completions
adb-ready completion bash > ~/.local/share/bash-completion/completions/adb-ready
```

Start a new shell. If the user completion directory is not loaded by your Bash
installation, source the generated file from `~/.bashrc`.

## zsh

```zsh
mkdir -p ~/.zfunc
adb-ready completion zsh > ~/.zfunc/_adb-ready
```

Add the directory before `compinit` in `~/.zshrc`:

```zsh
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

## fish

```fish
mkdir -p ~/.config/fish/completions
adb-ready completion fish > ~/.config/fish/completions/adb-ready.fish
```

fish loads the file automatically in new shell sessions.

## PowerShell

```powershell
New-Item -ItemType Directory -Force (Split-Path $PROFILE) | Out-Null
adb-ready completion powershell | Out-File -Append -Encoding utf8 $PROFILE
```

Reload the profile with `. $PROFILE` or open a new PowerShell session.

## Nushell

```nu
mkdir ($nu.data-dir | path join "vendor" "autoload")
adb-ready completion nushell | save --force ($nu.data-dir | path join "vendor" "autoload" "adb-ready.nu")
```

Nushell loads vendor autoload files in new sessions. The generated declarations
complete public commands while preserving ordinary file completion for command
arguments.

Regenerate the script after upgrading ADB Ready so newly added commands become
available to the shell.
