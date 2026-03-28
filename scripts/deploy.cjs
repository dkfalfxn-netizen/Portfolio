/**
 * 한 번에: my-app 빌드 → (변경 있으면) 커밋 → 푸시 → Vercel Git 연동 시 자동 배포
 * 실행: my-app 폴더에서 npm run deploy
 */
const { execSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const myApp = path.join(root, "my-app");

try {
  execSync("npm run build", { cwd: myApp, stdio: "inherit" });
} catch {
  process.exit(1);
}

process.chdir(root);
const status = execSync("git status --porcelain", { encoding: "utf8" });
if (status.trim()) {
  execSync("git add -A", { stdio: "inherit" });
  execSync('git commit -m "chore: deploy"', { stdio: "inherit" });
}
execSync("git push", { stdio: "inherit" });
