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
            this.generateSshKeys().then(this.connect.bind(this));
        } else {
            this.connect();
        }
    }

    connect() {
        this.node.status({ fill: "yellow", shape: "ring", text: `Connecting to ${this.config.address}:${this.config.port}` });
        this.ssh.connect({
            host: this.config.address,
            port: this.config.port,
            username: this.config.username,
            privateKey: `${this.config.sshkeyfolder}/id_rsa`
        }).then(this.onConnected.bind(this))
          .catch(err => this.node.error(`Connect error ${JSON.stringify(err)}`));
    }

    onError(err) {
        this.node.status({ fill: "yellow", shape: "ring", text: `Error connecting to ${this.config.address}:${this.config.port} ${err}` });
        this.node.error(`OnError:${JSON.stringify(err)}`);
        setTimeout(this.connect.bind(this), 1000);
    }

    onConnected() {
        this.node.log(`Connected to ${this.config.address}`);
        this.node.status({ fill: "green", shape: "dot", text: `Connected` });
        var node = this.node;
        this.ssh.exec("tail", ["-f", "messages"], {
            cwd: "/var/log",
            onStdout(stdout) { stdout.toString().split('\n').forEach(logln => node.send({ payload: logln })); },
            onStderr(err) { node.status({ fill: "yellow", shape: "ring", text: err }); }
        }).then(() => setTimeout(this.connect.bind(this), 1000))
          .catch(err => this.node.error(`onConnect error ${JSON.stringify(err)}`));
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
                    resolve(this.node.status({ fill: "yellow", shape: "ring", text: `SSH keys generated, please propogate them` }));
                }
            }.bind(this));
        });
    }

    hasPrivKey() {
        return fs.existsSync(`${this.config.sshkeyfolder}/id_rsa`);
    }
}
module.exports = { SysLog: SysLog }