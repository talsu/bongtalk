(function(){
	this.Bongtalk = function (url) { return new BongtalkClient(url, Qufox()); };

	var BongtalkClient = (function(){
		function BongtalkClient (url, qufox){
			this.url = url;
			this.qufox = qufox;
		}

		BongtalkClient.prototype.getAllChannel = function (callback) {
			$.ajax({
				type: "GET",
				url: "getAllChannel",						
				dataType: "json",
				success: function (response) { 
					if (isFunction(callback)) callback(response);
				},
				error: function (err) { 
					if (isFunction(callback)) callback({err:err});
				},
				complete: function () { }
			});
		};

		BongtalkClient.prototype.joinChannel = function (channelId, userId, userName) {
			return new Channel(channelId, userId, userName, this.qufox);
		};

		return BongtalkClient;
	})();


	var Channel = (function(){
		function Channel (channelId, userId, userName, qufox) {
			var self = this;
			self.channelId = channelId;
			self.userId = userId;
			self.userName = userName;
			self.qufox = qufox;

			self.receiveMessageCallback = null;

			qufox.join("channel-" + channelId, receive);

			function receive (packet) {
				if (!packet || !packet.header) return;
				switch (packet.header.type) {
					case 'message' : receiveMessage(packet.payload); break;					
				}
			}

			function receiveMessage (payload) {
				if (self.receiveMessageCallback) {
					self.receiveMessageCallback(payload);
				}
			}
		}

		Channel.prototype.onReceiveMessage = function (callback) {
			this.receiveMessageCallback = callback;
		};

		Channel.prototype.sendMessage = function (message) {
			var self = this;
			var packet = {
				header : { type : 'message' },
				payload : { userId : userId, message : message }
			};
			qufox.send("channel-" + self.channelId, packet, function(){});
		};

		Channel.prototype.getHistory = function () {

		};

		Channel.prototype.getUserList = function () {

		};

		Channel.prototype.leave = function () {

		};

		return Channel;
	})();

	function randomString(length) {
		var letters = 'abcdefghijklmnopqrstuvwxyz';
		var numbers = '1234567890';
		var charset = letters + letters.toUpperCase() + numbers;

		function randomElement(array) {
			with (Math)
				return array[floor(random()*array.length)];
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

"use strict";

/**
 * Created by Talsu on 13. 12. 3.
 */

var TalkUser = (function () {
	function TalkUser(id, name, connections) {
		this.id = id;
		this.name = name;
		this.connections = connections;
		this.refresh();
	}

	TalkUser.prototype.getSimpleUser = function() {
		return {id:this.id, name:this.name};
	};

	TalkUser.prototype.update = function(user) {
		this.name = user.name;
		this.connections = user.connections;
		this.refresh();
	};

	TalkUser.prototype.refresh = function(){
		this.isAlive = Array.isArray(this.connections) && this.connections.length > 0;
	};

	return TalkUser;
})();

var TalkClient = (function () {
	function TalkClient() {
		this.channelId = null;
		this.me = new TalkUser(null, null);
		this.others = [];
		this.lastMessage = null;
	}

	TalkClient.prototype.getUser = function(userId) {
		var selectedUsers = this.others.filter(function(item){ return item.id === userId;});
		if (selectedUsers && selectedUsers.length > 0)
		{
			return selectedUsers[0];
		}
		return null;
	};

	TalkClient.prototype.addUser = function (user) {
		if (!user || !(user instanceof TalkUser))
		{
			return null;
		}

		var selectedUsers = this.others.filter(function(item){return item.id === user.id;});

		if (selectedUsers.length > 0){
			// 존재한다면;
			var selectedUser = selectedUsers[0];
			selectedUser.update(user);
		}
		else{
			// 같은 ID를 가진 놈이 없다면 추가하라.
			this.others.push(user);
			return user;
		}

		return null;
	};

	TalkClient.prototype.removeUser = function (userId) {
		var user = this.getUser(userId);

		if (user)
		{
			this.others.splice(this.others.indexOf(user), 1);
		}

		return user;
	};

	TalkClient.prototype.getOtherUserNames = function() {
		return this.others.map(function(item){return item.name;});
	};

	return TalkClient;
})();