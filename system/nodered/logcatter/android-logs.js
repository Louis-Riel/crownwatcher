const { exec,spawn } = require('child_process');

class AdbLog {
    constructor (node,red,config) {
        this.node=node;
        this.red=red;
        this.authenticated=false;
        this.conmnected=false;
        this.daemonRunning=false;
        this.config = config;
        this.red.nodes.createNode(node,config);
        this.connect();
    }

    connect() {
        this.node.status({fill:"yellow",shape:"ring",text:`Connecting to ${this.config.address}`});
        this.adb = exec(`adb connect ${this.config.address}`,this.adbproc.bind(this) );
        this.adb.on("exit",(code,signal)=>this.node.error(`adb exited code:${code} signal:${signal}`));
    }

    adbproc(error, pout, perr) {
        if (error) {
            this.node.status({fill:"yellow",shape:"ring",text:`Got an auth failure again, look at your damned screen`});
            setTimeout(()=>this.adb = exec(`adb get-state`,this.adbproc.bind(this) ), 1000);
            return;
        }
        if (perr.includes("* daemon started successfully")) {
            this.daemonRunning=true;
        }
        if (pout.includes("failed to authenticate to")) {
            this.node.status({fill:"yellow",shape:"ring",text:`Got an auth failure again, look at your damned screen`});
            this.adb = exec(`adb connect ${this.config.address}`,this.adbproc.bind(this) );
            this.adb.on("exit",(code,signal)=>this.node.error(`adb2 exited code:${code} signal:${signal}`));
        } else if (pout == `connected to ${this.config.address}:5555\n`) {
            this.node.status({fill:"yellow",shape:"ring",text:`Connected waiting for auth`});
            this.conmnected=true;
            this.adb = exec(`adb get-state`,this.adbproc.bind(this) );
        } else if (pout == `already connected to ${this.config.address}:5555\n`) {
            this.node.status({fill:"green",shape:"dot",text:`Reconnected`});
            this.conmnected=true;
            this.adb = exec(`adb get-state`,this.adbproc.bind(this) );
        } else if (pout.includes(`error: device unauthorized.`)) {
            this.node.status({fill:"yellow",shape:"ring",text:`Got an auth failure again, look at your damned screen`});
            this.adb = exec(`adb get-state`,this.adbproc.bind(this) );
        } else if (pout == `device\n`) {
            this.logcat = spawn("adb",["logcat"]);
            this.logcat.stdout.on("data", data => data.toString().split('\n').forEach(logln => this.node.send({payload:logln})));
            this.logcat.stderr.on("data", err => this.node.error(`err:${err}`));
            this.logcat.on("exit", (code,signal)=>this.node.error(`Logcat exited code:${code} signal:${signal}`));
            this.logcat.on("close", code=>this.node.error(`Logcat closed code:${code}`));
            this.node.status({fill:"green",shape:"dot",text:`Connected`});
        } else {
            this.node.log(`(${pout})`);
            this.node.error(perr);
        }
    }
}
module.exports = {AdbLog:AdbLog}