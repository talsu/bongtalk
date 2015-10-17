(function () {
    "use strict";
    
    this.Qufox = function (url) { return new QufoxClient(url || "http://qufox.com"); }
    
    var QufoxClient = (function () {
        function QufoxClient(url) {
            var self = this;
            this.sessionCallbackMap = {};
            this.statusChangedCallbackArray = [];
            this.status = 'connecting';
            this.socket = io.connect(url, {
                'path': '/qufox.io',
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
                    if (callbackArray && callbackArray.length > 0) {
                        for (var i = 0; i < callbackArray.length; ++i) {
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
            
            this.reJoin = function () {
                for (var sessionId in self.sessionCallbackMap) {
                    self.socketClient.join(sessionId, function () { });
                }
            };
        }
        
        QufoxClient.prototype.onStatusChanged = function (callback) {
            if (isFunction(callback)) this.statusChangedCallbackArray.push(callback);
        }
        
        QufoxClient.prototype.subscribe =
		QufoxClient.prototype.on =
		QufoxClient.prototype.join = function (sessionId, callback) {
            var self = this;
            if (self.socket.connected) {
                self.socketClient.join(sessionId, function () {
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
		QufoxClient.prototype.send = function () { // sessionId, data, [echo], callback
            if (arguments.length == 3) // non echo
                this.socketClient.send(arguments[0], arguments[1], false, arguments[2]);
            else if (arguments.length == 4) // with echo parameter
                this.socketClient.send(arguments[0], arguments[1], arguments[2], arguments[3]);
            else
                throw 'Argument exception.';
        };
        
        QufoxClient.prototype.unsubscribe =
		QufoxClient.prototype.off =
		QufoxClient.prototype.leave = function (sessionId, callback) {
            var self = this;
            var currentMap = self.sessionCallbackMap[sessionId];
            if (!currentMap) return;
            
            var excludeMap = [];
            if (callback) {
                for (var i = 0; i < currentMap.length; ++i) {
                    if (currentMap[i] != callback) excludeMap.push(currentMap[i]);
                }
            }
            
            if (excludeMap.length == 0) {
                self.socketClient.leave(sessionId, function (data) {
                    delete self.sessionCallbackMap[sessionId];
                });
            }
            else {
                self.sessionCallbackMap[sessionId] = excludeMap;
            }
        };
        
        QufoxClient.prototype.leaveAll = function () {
            for (var sessionId in self.sessionCallbackMap) {
                self.socketClient.leave(sessionId, function () {
                    delete self.sessionCallbackMap[sessionId];
                });
            }
        };
        
        return QufoxClient;
    })();
    
    var SocketClient = (function () {
        function SocketClient(socket) {
            var self = this;
            this.callbackMap = {};
            this.socket = socket;
            
            self.socket.on('callback', function (response) {
                var callback = self.callbackMap[response.id];
                if (callback) {
                    delete self.callbackMap[response.id];
                    callback(response.data);
                };
            });
        };
        
        SocketClient.prototype.join = function (sessionId, callback) {
            var payloadId = randomString(8);
            if (isFunction(callback)) {
                this.callbackMap[payloadId] = callback;
            }
            this.socket.emit('join', { id: payloadId, sessionId: sessionId });
        };
        
        SocketClient.prototype.send = function (sessionId, data, echo, callback) {
            var payloadId = randomString(8);
            var payload = { id: payloadId, sessionId: sessionId, data: data, echo: echo };
            if (isFunction(callback)) {
                this.callbackMap[payloadId] = callback;
            }
            this.socket.emit('send', payload);
        };
        
        SocketClient.prototype.leave = function (sessionId, callback) {
            var payloadId = randomString(8);
            if (isFunction(callback)) {
                this.callbackMap[payloadId] = callback;
            }
            this.socket.emit('leave', { id: payloadId, sessionId: sessionId });
        };
        
        return SocketClient;
    })();
    
    //---- tool
    function randomString(length) {
        var letters = 'abcdefghijklmnopqrstuvwxyz';
        var numbers = '1234567890';
        var charset = letters + letters.toUpperCase() + numbers;
        
        function randomElement(array) {
            return array[Math.floor(Math.random() * array.length)];
        }
        
        var result = '';
        for (var i = 0; i < length; i++)
            result += randomElement(charset);
        return result;
    }
    
    function isFunction(object) {
        return !!(object && object.constructor && object.call && object.apply);
    }


}.call(this));

