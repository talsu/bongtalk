var cluster = require('cluster');
var util = require('util');
var BongtalkServer = require('./BongtalkServer').BongtalkServer;
var config = require('./config');

var command = require('optimist')
	.usage('Usage : $0 --port [num] --redisurl [url] --debug --single')
	.alias('p', 'port')
	.alias('r', 'redisurl')
	.alias('d', 'debug')
	.alias('s', 'single');

config.servicePort = command.argv.p || Number(config.servicePort) || 3000;
config.redisUrl = command.argv.r || config.redisUrl || 'redis://localhost';
config.isDebug = command.argv.d || config.isDebug || false;
config.single = command.argv.s || config.single || false;
config.websocket = command.argv.w || config.websocket || false;

var numCPUs = require('os').cpus().length;

if (!config.single && cluster.isMaster) {
	util.log('master('+process.pid+') started');
	util.log(util.inspect(config, {colors:true}));
	cluster.setupMaster({
		execArgv: process.execArgv.filter(function(s) { return s !== '--debug' })
	});

	var debugPortIndex = 0;

	// Fork workers.
	for (var i = 0; i < numCPUs; i++) {
		if (config.isDebug) cluster.settings.execArgv.push('--debug=' + (5859 + debugPortIndex++));
		cluster.fork();
		if (config.isDebug) cluster.settings.execArgv.pop();
	}

	cluster.on('listening', function(worker, address) {
		util.log("worker(pid:"+worker.process.pid+") is now listening " + address.address + ":" + address.port);
	});

	cluster.on('exit', function(worker, code, signal) {
		if( signal ) {
			util.log("worker(pid:"+worker.process.pid+") was killed by signal: "+signal);
		} else if( code !== 0 ) {
			util.log("worker(pid:"+worker.process.pid+") exited with error code: "+code);
		} else {
			util.log("worker(pid:"+worker.process.pid+") success!");
		}
		util.log('restarting...');

		if (config.isDebug) cluster.settings.execArgv.push('--debug=' + (5859 + debugPortIndex++));
		cluster.fork();
		if (config.isDebug) cluster.settings.execArgv.pop();
	});
} else {
	new BongtalkServer(config).run();
}
