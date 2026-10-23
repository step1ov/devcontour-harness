// Fixture project test: checks src/greet.js and writes a JUnit report to
// the path the harness gives (DEVCONTOUR_REPORT_PATH), else .reports/junit.xml.
const fs = require('fs');
const path = require('path');
let ok = false;
let message = '';
try {
  const { greet } = require(path.join(process.cwd(), 'src', 'greet.js'));
  ok = greet('Ada') === 'Hello, Ada!';
  message = 'greet("Ada") = ' + greet('Ada');
} catch (error) {
  message = String(error.message);
}
const report = process.env.DEVCONTOUR_REPORT_PATH || '.reports/junit.xml';
fs.mkdirSync(path.dirname(report), { recursive: true });
const failure = ok ? '' : '<failure message="' + message.replace(/[<&"]/g, '') + '"/>';
fs.writeFileSync(
  report,
  '<testsuite><testcase classname="greet" name="greets">' + failure + '</testcase></testsuite>',
);
console.log(ok ? 'greet: ok' : 'greet: ' + message);
process.exitCode = ok ? 0 : 1;
