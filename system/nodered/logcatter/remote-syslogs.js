const keygen = require('ssh-keygen');
const fs = require('fs');
const { NodeSSH } = require('node-ssh')

class SysLog {
    constructor(node, red, config) {
        this.node = node;
        this.red = red;
        this.authenticated = false;
        this.conmnected = false;
        this.daemonRunning = false;
        this.config = config;
        this.red.nodes.createNode(this.node, config);
        this.ssh = new NodeSSH();
        if (!this.hasPrivKey()) {
            this.generateSshKeys().then(res => this.connect());
        } else {
            this.connect();
        }
    }

    connect() {
        this.node.status({ fill: "yellow", shape: "ring", text: `Connecting to ${this.config.address}` });
        this.ssh.connect({
            host: this.config.address,
            port: this.config.port,
            username: 'root',
            privateKey: `${this.config.sshkeyfolder}/id_rsa`
        }).then(() => {
            this.node.status({ fill: "green", shape: "dot", text: `Connected` });
            var node = this.node;
            this.ssh.exec("tail", ["-f", "messages"], {
                cwd: "/var/log",
                onStdout(stdout) { stdout.toString().split('\n').forEach(logln => node.send({ payload: logln })) },
                onStderr(err) { node.status({ fill: "yellow", shape: "ring", text: err }) }
            });
        }).catch(err => {
            this.node.status({ fill: "yellow", shape: "ring", text: err });
            this.node.error(err);
            setTimeout(() => this.connect(), 1000);
        });
    }

    generateSshKeys() {
        return new Promise((resolve, reject) => {
            this.node.log(`Generating SSH keys in ${this.config.sshkeyfolder}`);
            if (!fs.existsSync(this.config.sshkeyfolder)) {
                fs.mkdirSync(this.config.sshkeyfolder, { mode: 0o700 });
            }
            keygen({
                location: `${this.config.sshkeyfolder}/id_rsa`,
                comment: 'autogenned by node-red',
                password: false,
                read: true,
                format: 'PEM'
            }, function(err, out) {
                if (err) {
                    this.node.error(err);
                    this.node.status({ fill: "red", shape: "ring", text: err });
                    reject(err);
                } else {
                    this.node.status({ fill: "yellow", shape: "ring", text: `SSH keys generated, please propogate them` });
                    resolve(this.config.sshkeyfolder);
                }
            }.bind(this));
        });
    }

    hasPrivKey() {
        return fs.existsSync(`${this.config.sshkeyfolder}/id_rsa`);
    }
}
module.exports = { SysLog: SysLog }