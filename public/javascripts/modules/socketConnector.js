'use strict'

define(['socket', 'underscore', 'eventEmitter', 'modules/RequestResponseSocketClient'], function (io, _, EventEmitter, RequestResponseSocketClient){
	function SocketConnector(io){
		var self = this;
		this.status = 'connecting';
		this.socket = io.connect(window.location.origin);
		this.reqClient = new RequestResponseSocketClient(this.socket);
		this.reconnectFlag = false;
		this.socket.on('connect', function () {
			self.setStatus('connected'); self.emit('connected'); 
			if (self.reconnectFlag){
				self.reconnectFlag = false;	
				self.emit('reconnected');
			}			
		});
		this.socket.on('connecting', function () {self.setStatus('connecting');});
		this.socket.on('disconnect', function () {self.setStatus('disconnect');});
		this.socket.on('connect_failed', function () {self.setStatus('connect_failed');});
		this.socket.on('error', function () {self.setStatus('error');});
		this.socket.on('reconnect_failed', function () {self.setStatus('reconnect_failed');});
		this.socket.on('reconnect', function () {self.setStatus('reconnect'); self.reconnectFlag = true;});
		this.socket.on('reconnecting', function () {self.setStatus('reconnecting');});

		this.socket.on('onNewTalk', function (channelData){self.channelEmit('onNewTalk', channelData);});
		this.socket.on('onAddUser', function (channelData){self.channelEmit('onAddUser', channelData);});
		this.socket.on('onRemoveUser', function (channelData){self.channelEmit('onRemoveUser', channelData);});
		this.socket.on('onUpdateUser', function (channelData){self.channelEmit('onUpdateUser', channelData);});
	};

	SocketConnector.prototype.setStatus = function (status){
		var self = this;
		self.status = status;
		self.emit('statusChanged', self.status);
	};

	SocketConnector.prototype.addEventListener = function (eventName, channelId, callback){
		this.addListener(eventName + '-' + channelId, callback);
	};

	SocketConnector.prototype.removeEventListener = function (eventName, channelId, callback){
		this.removeListener(eventName + '-' + channelId, callback);
	};

	SocketConnector.prototype.request = function (url, data, callback){
		this.reqClient.request(url, data, callback);
	};

	SocketConnector.prototype.channelEmit = function (eventName, channelData){
		if (channelData && channelData.channelId){
			this.emit(eventName + '-' + channelData.channelId, channelData.data);
		}
	};

	SocketConnector.prototype.runWithConnection = function (callback){
		if (_.isFunction(callback)){
			if (this.status === 'connected'){
				callback();
			}
			else{
				this.addOnceListener('connected', callback);
			}
		}
	};

	_.extend(SocketConnector.prototype, EventEmitter.prototype);

	return new SocketConnector(io)
});