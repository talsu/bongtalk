var cluster = require('cluster');
var util = require('util');
var BongTalkServer = require('./BongTalkServer').BongTalkServer;
var config = require('./config');

var numCPUs = require('os').cpus().length;

if (cluster.isMaster) {
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
	new BongTalkServer(config.servicePort, config.redisUrl).run();
}

