'use strict';

define(['modules/uuid'], function(uuid){
	function RequestResponseSocketClient(socket){
		var self = this;
		this.callbackMap = {};
		this.socket = socket;
		this.socket.on('response', function(response){
			var callback = self.callbackMap[response.id];
			if (callback){
				delete self.callbackMap[response.id];
				callback(response.data);
			};
		});
	};

	RequestResponseSocketClient.prototype.request = function(url, data, callback){
		var id = uuid();
		var request = {id:id, url:url, data:data};
		this.callbackMap[id] = callback;
		this.socket.emit('request', request);
	};

	return RequestResponseSocketClient;
});
