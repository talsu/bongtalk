var RequestResponseSocketClient = (function () {
	function RequestResponseSocketClient(socket) {
		var self = this;
		this.callbackMap = {};
		this.socket = socket;
		// this.socket.on('response', function (response) {
		// 	var callback = self.callbackMap[response.id];
		// 	if (callback) {
		// 		delete self.callbackMap[response.id];
		// 		callback(response.data);
		// 	};
		// });

		this.createCallback('join');
		this.createCallback('send');
		this.createCallback('leave');
	};

	RequestResponseSocketClient.prototype.createCallback = function (name) {
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

	// RequestResponseSocketClient.prototype.request = function (url, data, callback) {
	// 	var id = uuid();
	// 	var request = { id: id, url: url, data: data };
	// 	if (_.isFunction(callback)) {
	// 		this.callbackMap[id] = callback;
	// 	}
	// 	this.socket.emit('request', request);
	// };

	RequestResponseSocketClient.prototype.join = function (sessionId, callback) {
		if (_.isFunction(callback)) {
			this.callbackMap['join-' + sessionId] = callback;
		}
		this.socket.emit('join', sessionId);
	};

	RequestResponseSocketClient.prototype.send = function (sessionId, data, callback) {
		var id = randomString(8);
		var payload = { id: id, sessionId: sessionId, data: data };
		if (_.isFunction(callback)) {
			this.callbackMap['send-' + id] = callback;
		}
		this.socket.emit('send', payload);
	};

	RequestResponseSocketClient.prototype.leave = function (sessionId, callback) {
		if (_.isFunction(callback)) {
			this.callbackMap['leave-' + sessionId] = callback;
		}
		this.socket.emit('leave', sessionId);
	};


	return RequestResponseSocketClient;
})();


var MessagingClient = (function () {
	function MessagingClient(url) {
		var self = this;
		this.sessionCallbackMap = {};
		this.status = 'connecting';
		this.socket = io.connect(url, {
			'sync disconnect on unload': true,
			'reconnection limit': 6000, //defaults Infinity
			'max reconnection attempts': Infinity // defaults to 10
		});
		this.reqClient = new RequestResponseSocketClient(this.socket);
		this.reconnectFlag = false;
		this.socket.on('connect', function () { self.setStatus('connecting'); });
		this.socket.on('connected', function () {
			self.setStatus('connected'); self.emit('connected');
			if (self.reconnectFlag) {
				self.reconnectFlag = false;
				self.emit('reconnected');
			}
		});
		this.socket.on('connecting', function () { self.setStatus('connecting'); });
		this.socket.on('disconnect', function () { self.setStatus('disconnect'); });
		this.socket.on('connect_failed', function () { self.setStatus('connect_failed'); });
		this.socket.on('error', function () { self.setStatus('error'); });
		this.socket.on('reconnect_failed', function () { self.setStatus('reconnect_failed'); });
		this.socket.on('reconnect', function () { self.setStatus('reconnect'); self.reconnectFlag = true; });
		this.socket.on('reconnecting', function () { self.setStatus('reconnecting'); });

		// this.socket.on('sessionEvent', function (eventArg) { self.sessionEmit(eventArg.eventName, eventArg.sessionData); });

		this.socket.on('receive', function (payload) {
			if (payload && payload.id) {
				self.emit('session-' + payload.id, payload.data);
			}
		});
	}

	MessagingClient.prototype.setStatus = function (status) {
		if (this.status !== status) {
			var self = this;
			self.status = status;
			self.emit('statusChanged', self.status);
		}
	};

	MessagingClient.prototype.join = function (sessionId, callback) {
		var self = this;
		self.reqClient.join(sessionId, function (){
			if (!self.sessionCallbackMap[sessionId]) {				
				self.addListener('session-' + sessionId, callback);	
			}
			self.sessionCallbackMap[sessionId] = callback;
		});		
	};

	MessagingClient.prototype.send = function (sessionId, data, callback) {
		this.reqClient.send(sessionId, data, callback);
	};

	MessagingClient.prototype.leave = function (sessionId, callback) {
		var self = this;

		self.reqClient.leave(sessionId, function (data){
			var sessionCallback = self.sessionCallbackMap[sessionId];
			if (sessionCallback) {
				delete self.sessionCallbackMap[sessionId];
				self.removeListener('session-' + sessionId, sessionCallback);	
			};

			if (_.isFunction(callback)) callback(data);
			
		});		
	};

	MessagingClient.prototype.runWithConnection = function (callback) {
		if (_.isFunction(callback)) {
			if (this.status === 'connected') {
				callback();
			}
			else {
				this.addOnceListener('connected', callback);
			}
		}
	};

	_.extend(MessagingClient.prototype, EventEmitter.prototype);

	return MessagingClient;
})();


//---- tool
function randomString(length) {
	var letters = 'abcdefghijklmnopqrstuvwxyz';
	var numbers = '1234567890';
	var charset = letters + letters.toUpperCase() + numbers;

	function randomElement(array) {
		with (Math)
			return array[floor(random()*array.length)];
	}

	var R = '';
	for(var i=0; i<length; i++)
		R += randomElement(charset);
	return R;
}