import { CommandClass } from "./types.js";

export function classifyCommand(command: string | undefined | null): CommandClass {
  if (!command) return "unknown";
  const value = command.toLowerCase().trim();

  if (/\b(test|jest|vitest|mocha|pytest|rspec|go test|cargo test|dotnet test|xcodebuild test)\b/.test(value) || /\bnpm\s+(run\s+)?test\b/.test(value) || /\byarn\s+test\b/.test(value) || /\bpnpm\s+(run\s+)?test\b/.test(value)) return "test";
  if (/\b(lint|eslint|ruff|flake8|pylint|rubocop)\b/.test(value) || /\bnpm\s+(run\s+)?lint\b/.test(value)) return "lint";
  if (/\b(tsc|typecheck|mypy|pyright|sorbet|flow)\b/.test(value) || /\bnpm\s+(run\s+)?typecheck\b/.test(value)) return "typecheck";
  if (/\b(build|webpack|vite build|next build|turbo build|cargo build|go build|dotnet build|xcodebuild)\b/.test(value) || /\bnpm\s+(run\s+)?build\b/.test(value)) return "build";
  if (/\b(git)\b/.test(value)) return "git";
  if (/\b(npm install|yarn install|pnpm install|bun install|pip install|poetry install|bundle install)\b/.test(value)) return "install";
  if (/\b(npm start|npm run dev|yarn dev|pnpm dev|next dev|vite|node|python|tsx|ts-node)\b/.test(value)) return "run";
  return "unknown";
}

export function isVerificationCommand(commandClass: CommandClass): boolean {
  return commandClass === "test" || commandClass === "lint" || commandClass === "typecheck" || commandClass === "build";
}
