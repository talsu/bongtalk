(function () {
	"use strict";

	this.BongtalkApiClient = function (reqSender) { return new BongtalkApiClient(reqSender); };

	var BongtalkApiClient = (function () {
		function BongtalkApiClient(reqSender) {
			this.sendRequest = reqSender;
		}

		// Sign
		BongtalkApiClient.prototype.checkUserExist = function (userId, callback) {
			this.sendRequest({
				method: 'GET',
				url: 'api/checkUserExist',
				params: {userId:userId}
			}, callback);
		};

		BongtalkApiClient.prototype.signIn = function (userId, password, callback) {
			this.sendRequest({
				method: 'POST',
				url: 'api/signIn',
				data: {userId:userId, password:password}
			}, callback);
		};

		BongtalkApiClient.prototype.signInByGuest = function (user, callback) {
			this.sendRequest({
				method: 'POST',
				url: 'api/signInByGuest',
				data: {user:user}
			}, callback);
		};

		BongtalkApiClient.prototype.signUp = function (user, callback) {
			this.sendRequest({
				method: 'POST',
				url: 'api/signUp',
				data:  {user:user}
			}, callback);
		};

		// My Info
		BongtalkApiClient.prototype.refreshToken = function(callback) {
			this.sendRequest({
				method: 'GET',
				url: 'api/refreshToken'
			}, callback);
		};

		BongtalkApiClient.prototype.getMyInfo = function (callback) {
			this.sendRequest({
				method: 'GET',
				url: 'api/user'
			}, callback);
		};

		BongtalkApiClient.prototype.setMyInfo = function (userId, data, callback) {
			this.sendRequest({
				method: 'PUT',
				url: 'api/users/' + userId,
				data: data
			}, callback);
		};

		BongtalkApiClient.prototype.changePassword = function (currentPassword, newPassword, callback) {
			this.sendRequest({
				method: 'POST',
				url: 'api/changePassword',
				data: {currentPassword:currentPassword, newPassword:newPassword}
			}, callback);
		};

		BongtalkApiClient.prototype.getRandomAvatarUrl = function (callback){
			this.sendRequest({
				method: 'GET',
				url: 'api/avatars/random'
			}, callback);
		};

		// Session
		BongtalkApiClient.prototype.getUserSessions = function (userId, callback) {
			this.sendRequest({
				method: 'GET',
				url: 'api/users/' + userId + '/sessions'
			}, callback);
		};

		BongtalkApiClient.prototype.getSessionUsers = function (sessionId, callback) {
			this.sendRequest({
				method: 'GET',
				url: 'api/sessions/' + sessionId + '/users'
			}, callback);
		};

		BongtalkApiClient.prototype.getPublicSessions = function (callback) {
			this.sendRequest({
				method: 'GET',
				url: 'api/sessions/type/public'
			}, callback);
		};

		// Session
		BongtalkApiClient.prototype.getSession = function (sessionId, callback) {
			this.sendRequest({
				method: 'GET',
				url: 'api/sessions/' + sessionId
			}, callback);
		};

		BongtalkApiClient.prototype.createSession = function (name, type, users, callback) {
			var sessionUsers = [];
			if (_.isString(users)) {
				sessionUsers.push(users);
			} else if (_.isArray(users)) {
				_.each(users, function (userId) {
					if (!_.contains(sessionUsers, userId)) sessionUsers.push(userId);
				});
			}

			this.sendRequest({
				method: 'POST',
				url: 'api/sessions',
				data: { name: name, type: type, users: sessionUsers }
			}, callback);
		};

		BongtalkApiClient.prototype.joinSession = function (sessionId, callback) {
			this.sendRequest({
				method: 'POST',
				url: 'api/sessions/' + sessionId + '/users',
				data: {}
			}, callback);
		};

		// Telegram
		BongtalkApiClient.prototype.getTelegrams = function (sessionId, ltTime, count, callback) {
			this.sendRequest({
				method: 'GET',
				url: 'api/sessions/' + sessionId + '/telegrams',
				params: { ltTime: ltTime, count: count }
			}, callback);
		};

		BongtalkApiClient.prototype.addTelegram = function (sessionId, userName, type, subType, data, callback) {
			this.sendRequest({
				method: 'POST',
				url: 'api/sessions/' + sessionId + '/telegrams',
				data: { userName: userName, type: type, subType: subType, data: data }
			}, callback);
		};

		// for Admin (only working with admin account)
		BongtalkApiClient.prototype.admin_getAllUser = function (callback) {
			this.sendRequest({
				method: 'GET',
				url: 'api/admin/users',
			}, callback);
		};

		BongtalkApiClient.prototype.admin_removeUser = function (userId, callback) {
			this.sendRequest({
				method: 'DELETE',
				url: 'api/admin/users/' + userId,
			}, callback);
		};

		BongtalkApiClient.prototype.admin_getAllSession = function (callback) {
			this.sendRequest({
				method:'GET',
				url:'api/admin/sessions'
			}, callback);
		};

		BongtalkApiClient.prototype.admin_getSession = function (sessionId, callback) {
			this.sendRequest({
				method:'GET',
				url:'api/admin/sessions/' + sessionId
			}, callback);
		};

		BongtalkApiClient.prototype.admin_removeSession = function (sessionId, callback){
			this.sendRequest({
				method:'DELETE',
				url:'api/admin/sessions/' + sessionId
			}, callback);
		};

		return BongtalkApiClient;
	})();
}.call(this));
