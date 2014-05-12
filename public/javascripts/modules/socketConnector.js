'use strict'

define(['socket', 'underscore', 'eventEmitter', 'modules/RequestResponseSocketClient'], function (io, _, EventEmitter, RequestResponseSocketClient){
	function SocketConnector(io){
		var self = this;

		this.socket = io.connect('http://localhost:3000');
		this.reqClient = new RequestResponseSocketClient(this.socket);

		this.socket.on('connect', function () {self.setStatus('connected'); });
		this.socket.on('connecting', function () {self.setStatus('connecting');});
		this.socket.on('disconnect', function () {self.setStatus('disconnect');});
		this.socket.on('connect_failed', function () {self.setStatus('connect_failed');});
		this.socket.on('error', function () {self.setStatus('error');});
		this.socket.on('reconnect_failed', function () {self.setStatus('reconnect_failed');});
		this.socket.on('reconnect', function () {self.setStatus('reconnect');});
		this.socket.on('reconnecting', function () {self.setStatus('reconnecting');});
	};

	SocketConnector.prototype.setStatus = function (status){
		var self = this;
		self.status = status;
		self.emit('statusChanged', self.status);
	};

	SocketConnector.prototype.request = function (url, data, callback){
		this.reqClient.request(url, data, callback);
	};

	_.extend(SocketConnector.prototype, EventEmitter.prototype);

	return new SocketConnector(io)
});