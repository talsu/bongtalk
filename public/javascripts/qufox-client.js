(function(){
	"use strict";
	
	this.Qufox = function(url) { return new QufoxClient(url || "http://qufox.com"); }

	var QufoxClient = (function () {
		function QufoxClient(url) {
			var self = this;
			this.sessionCallbackMap = {};
			this.statusChangedCallbackArray = [];
			this.status = 'connecting';
			this.socket = io.connect(url, {
				'sync disconnect on unload': true,
				'reconnection limit': 6000, //defaults Infinity
				'max reconnection attempts': Infinity // defaults to 10
			});
			this.socketClient = new SocketClient(this.socket);
			this.reconnectFlag = false;
			this.socket.on('connect', function () { self.setStatus('connecting'); });
			this.socket.on('connected', function () {				
				if (self.reconnectFlag) {
					self.reconnectFlag = false;
					self.setStatus('reconnected');
				}
				else {
					self.setStatus('connected');
				}

			});
			this.socket.on('connecting', function () { self.setStatus('connecting'); });
			this.socket.on('disconnect', function () { self.setStatus('disconnect'); });
			this.socket.on('connect_failed', function () { self.setStatus('connect_failed'); });
			this.socket.on('error', function () { self.setStatus('error'); });
			this.socket.on('reconnect_failed', function () { self.setStatus('reconnect_failed'); });
			this.socket.on('reconnect', function () { self.setStatus('reconnect'); self.reconnectFlag = true; });
			this.socket.on('reconnecting', function () { self.setStatus('reconnecting'); });
			
			this.socket.on('receive', function (payload) {
				if (payload && payload.id) {				
					var callbackArray = self.sessionCallbackMap[payload.id];
					if (callbackArray && callbackArray.length > 0){
						for (var i = 0; i < callbackArray.length; ++i){							
							if (isFunction(callbackArray[i])) callbackArray[i](payload.data);
						}
					}					
				}
			});

			this.setStatus = function (status) {
				if (self.status !== status) {				
					self.status = status;
					for (var i = 0; i < self.statusChangedCallbackArray.length; ++i) {
						self.statusChangedCallbackArray[i](status);
					}

					if (self.socket.connected && (status === 'connected' || status === 'reconnected')) {
						self.reJoin();
					}
				}
			};

			this.reJoin = function (){
				for (var sessionId in self.sessionCallbackMap) {
					self.socketClient.join(sessionId, function() {});
				}
			};
		}

		QufoxClient.prototype.onStatusChanged = function(callback) {
			if (isFunction(callback)) this.statusChangedCallbackArray.push(callback);
		}

		QufoxClient.prototype.subscribe =
		QufoxClient.prototype.on =
		QufoxClient.prototype.join = function (sessionId, callback) {
			var self = this;
			if (self.socket.connected) {
				self.socketClient.join(sessionId, function (){
					if (!self.sessionCallbackMap[sessionId]) self.sessionCallbackMap[sessionId] = [];
					self.sessionCallbackMap[sessionId].push(callback);
				});	
			}
			else {
				if (!self.sessionCallbackMap[sessionId]) self.sessionCallbackMap[sessionId] = [];
					self.sessionCallbackMap[sessionId].push(callback);
			}
		};

		QufoxClient.prototype.publish =
		QufoxClient.prototype.send = function (sessionId, data, callback) {
			this.socketClient.send(sessionId, data, callback);
		};

		QufoxClient.prototype.unsubscribe =
		QufoxClient.prototype.off =
		QufoxClient.prototype.leave = function (sessionId, callback) {
			var self = this;
			var currentMap = self.sessionCallbackMap[sessionId];
			if (!currentMap) return;

			var excludeMap = [];
			for (var i = 0; i < currentMap.length; ++i){
				if (currentMap[i] != callback) excludeMap.push(currentMap[i]);
			}

			if (excludeMap.length == 0){
				self.socketClient.leave(sessionId, function (data){
					delete self.sessionCallbackMap[sessionId];
				});
			}
			else{
				self.sessionCallbackMap[sessionId] = excludeMap;
			}
			// self.socketClient.leave(sessionId, function (data){
			// 	var sessionCallback = self.sessionCallbackMap[sessionId];
			// 	if (sessionCallback) {
			// 		delete self.sessionCallbackMap[sessionId];				
			// 	};

			// 	if (isFunction(callback)) callback(data);
			// });		
		};

		return QufoxClient;
	})();

	var SocketClient = (function () {
		function SocketClient(socket) {
			var self = this;
			this.callbackMap = {};
			this.socket = socket;
			this.createCallback('join');
			this.createCallback('send');
			this.createCallback('leave');
		};

		SocketClient.prototype.createCallback = function (name) {
			var self = this;		
			this.socket.on(name + 'Callback', function (response) {
				var key = name +'-' + response.id;
				var callback = self.callbackMap[key];
				if (callback) {
					delete self.callbackMap[key];
					callback(response.data);
				};
			});
		};

		SocketClient.prototype.join = function (sessionId, callback) {
			if (isFunction(callback)) {
				this.callbackMap['join-' + sessionId] = callback;
			}
			this.socket.emit('join', sessionId);
		};

		SocketClient.prototype.send = function (sessionId, data, callback) {
			var id = randomString(8);
			var payload = { id: id, sessionId: sessionId, data: data };
			if (isFunction(callback)) {
				this.callbackMap['send-' + id] = callback;
			}
			this.socket.emit('send', payload);
		};

		SocketClient.prototype.leave = function (sessionId, callback) {
			if (isFunction(callback)) {
				this.callbackMap['leave-' + sessionId] = callback;
			}
			this.socket.emit('leave', sessionId);
		};

		return SocketClient;
	})();

	//---- tool
	function randomString(length) {
		var letters = 'abcdefghijklmnopqrstuvwxyz';
		var numbers = '1234567890';
		var charset = letters + letters.toUpperCase() + numbers;

		function randomElement(array) {			
			return array[Math.floor(Math.random()*array.length)];
		}

		var result = '';
		for(var i=0; i<length; i++)
			result += randomElement(charset);
		return result;
	}

	function isFunction(object) {
		return !!(object && object.constructor && object.call && object.apply);
	}


}.call(this));

