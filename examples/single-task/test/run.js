// Тест примера: проверяет src/greet.js и пишет JUnit в путь, который задаёт harness.
const fs = require('fs');
let ok = false;
let message = '';
try {
  const { greet } = require(process.cwd() + '/src/greet.js');
  ok = greet('Ada') === 'Hello, Ada!';
  message = 'greet("Ada") = ' + greet('Ada');
} catch (error) {
  message = String(error.message);
}
const report = process.env.DEVCONTOUR_REPORT_PATH || 'test-results/junit.xml';
fs.mkdirSync(require('path').dirname(report), { recursive: true });
const failure = ok ? '' : '<failure message="' + message.replace(/[<&"]/g, '') + '"/>';
fs.writeFileSync(
  report,
  '<testsuite><testcase classname="greet" name="greets">' + failure + '</testcase></testsuite>',
);
console.log(ok ? 'greet: ok' : 'greet: ' + message);
