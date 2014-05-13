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

		this.socket.on('onNewTalk', function(channelData){self.channelEmit('onNewTalk', channelData);});
		this.socket.on('onAddUser', function(channelData){self.channelEmit('onAddUser', channelData);});
		this.socket.on('onRemoveUser', function(channelData){self.channelEmit('onRemoveUser', channelData);});
		this.socket.on('onUpdateUser', function(channelData){self.channelEmit('onUpdateUser', channelData);});
	};

	SocketConnector.prototype.setStatus = function (status){
		var self = this;
		self.status = status;
		self.emit('statusChanged', self.status);
	};

	SocketConnector.prototype.onNewTalk = function (channelId, callback){
		this.on('onNewTalk-' + channelId, callback);
	};

	SocketConnector.prototype.onAddUser = function (channelId, callback){
		this.on('onAddUser-' + channelId, callback);
	};

	SocketConnector.prototype.onRemoveUser = function (channelId, callback){
		this.on('onRemoveUser-' + channelId, callback);
	};

	SocketConnector.prototype.onUpdateUser = function (channelId, callback){
		this.on('onUpdateUser-' + channelId, callback);
	};

	SocketConnector.prototype.request = function (url, data, callback){
		this.reqClient.request(url, data, callback);
	};

	SocketConnector.prototype.channelEmit = function (eventName, channelData){
		if (channelData && channelData.channelId){
			this.emit(eventName + '-' + channelData.channelId, channelData.data);
		}
	};

	_.extend(SocketConnector.prototype, EventEmitter.prototype);

	return new SocketConnector(io)
});