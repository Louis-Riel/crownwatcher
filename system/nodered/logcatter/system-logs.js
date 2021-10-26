const { AdbLog } = require('./android-logs.js');
const { SysLog } = require('./remote-syslogs.js');

module.exports = function(RED) {
    function initit(config) {
        switch (config.logtype) {
            case "Android":
                new AdbLog(this,RED,config);
            break;
            case "MessageTail":
                new SysLog(this,RED,config);
            break;
            default:
                this.err(`Invalid node type ${config.logtype}`);
            break;
        }
    }
    RED.nodes.registerType("system-logs",initit);
}