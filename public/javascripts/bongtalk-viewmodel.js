
bongtalkControllers.factory('viewmodel', ['$rootScope', '$filter', '$location', '$routeParams', 'apiClient', 'bongtalkAutoRefreshToken', function ($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken) {
  return BongtalkViewModel($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken);
}]);


(function () {
  "use strict";

  this.BongtalkViewModel = function ($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken) { return new BongtalkViewModel($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken); };

  var BongtalkViewModel = (function () {
    function BongtalkViewModel($rootScope, $filter, $location, $routeParams, apiClient, bongtalkAutoRefreshToken) {
      this.instanceId = this.randomString(8);
      this.$rootScope = $rootScope;
      this.$filter = $filter;
      this.$location = $location;
      this.$routeParams = $routeParams;
      this.apiClient = apiClient;
      this.isLoaded = false;
      this.data = null;
      this.qufox = null;
      // this.qufox = new Qufox(window.location.protocol + '//' + window.location.host);
      this.bongtalkAutoRefreshToken = bongtalkAutoRefreshToken;
      this.readyCallbackList = [];
    }

    BongtalkViewModel.prototype.ready = function (callback) {
      if (this.isLoaded)
      callback();
      else
      this.readyCallbackList.push(callback);
    };

    // context Load (signin or Window refresh)
    BongtalkViewModel.prototype.load = function (user, callback) {
      var self = this;
      if (!user) { callback('user is not exist', null); return; }
      self.apiClient.getUserSessions(user.id, function (err, result) {
        if (!err) {
          self.data = { me: user, sessionList: result, userList: [user] };
          // token auto refresh service Start.
          self.bongtalkAutoRefreshToken.start();

          self.connectQufox(function (){

            self.isLoaded = true;
            // join private session
            self.qufox.join('private:' + user.id, function (packet) {
              self.privatePacketReceived(packet);
            });

            // join sessions.
            if (angular.isArray(self.data.sessionList)) {
              _.each(self.data.sessionList, function (session) {
                self.qufox.join('session:' + session._id, function (packet) {
                  self.sessionPacketReceived(session, packet);
                });
              });
            }
          });
        }

        // call ready callback.
        if (_.isFunction(callback)) callback(err, result);
        if (self.readyCallbackList.length > 0) {
          var readyCallback = null;
          while ((readyCallback = self.readyCallbackList.shift())){
            readyCallback(err, result);
          }
        }
      });
    };

    BongtalkViewModel.prototype.connectQufox = function(callback) {
      var self = this;
      if (self.qufox) {
        callback();
      }
      else {
        self.apiClient.getQufoxUrl(function (err, result){
          if (!self.qufox) {
            self.qufox = new Qufox(result || window.location.protocol + '//' + window.location.host);
          }

          callback();
        });
      }
    };

    // context UnLoad (Sign out)
    BongtalkViewModel.prototype.unload = function (callback) {
      if (this.isLoaded){
        this.isLoaded = false;
        this.data = null;
        this.bongtalkAutoRefreshToken.stop();
        this.qufox.leaveAll();
      }
    };

    BongtalkViewModel.prototype.setMyInfo = function (data, callback){
      var self = this;
      self.apiClient.setMyInfo(self.data.me.id, data, function (err, result){
        if (!err) {
          self.updateUser(data);
          // send private packet (For multi device.)
          self.qufox.send('private:' + self.data.me.id, {name:'setMyInfo', object:data}, function(){});
          data.id = self.data.me.id;

          // send session packet (Notify to other users in session.)
          _.each(self.data.sessionList, function (session){
            self.qufox.send('session:' + session._id, {name:'updateUser', object:data}, function(){});
          });
        }
        if (_.isFunction(callback)) callback(err, result);
      });
    };

    BongtalkViewModel.prototype.updateUser = function (user){
      var self = this;
      if (!user) return;
      var existUser = null;

      if (user.id){
        existUser =_.find(self.data.userList, function (u) {return u.id == user.id;});
      }
      else {
        existUser = self.data.me;
      }

      if (existUser){
        for (var property in user) {
          existUser[property] = user[property];
        }
      }
      else{
        self.data.userList.push(user);
      }
    };

    BongtalkViewModel.prototype.loadUsers = function (session, callback) {
      var self = this;
      if (!session) return;

      self.apiClient.getSessionUsers(session._id, function (err, result) {
        if (!err) {
          _.each(result, function(user){ self.updateUser(user);});
        }

        if (_.isFunction(callback)) callback(err, result);
      });
    };

    BongtalkViewModel.prototype.loadTelegrams = function (session, callback) {
      var self = this;

      if (session.isTelegramLoaded) {
        if (_.isFunction(callback)) callback(null, session.telegrams);
        return;
      }

      self.apiClient.getTelegrams(session._id, 0, 0, function (err, result) {
        if (!err && result) {
          if (result.users && result.users.length > 0){
            _.each(result.users, function (user){
              self.updateUser(user);
            });
          }

          if (result.telegrams && result.telegrams.length > 0){
            _.each(result.telegrams, function (telegram) {
              self.addTelegram(session, telegram);
            });
          }

          session.isTelegramLoaded = true;
        }

        if (_.isFunction(callback)) callback(err, result);
      });
    };

    BongtalkViewModel.prototype.createSession = function (name, type, callback) {
      var self = this;
      self.apiClient.createSession(name, type, [self.data.me.id], function (err, result) {
        if (!err) {
          self.qufox.send('private:' + self.data.me.id, {name:'joinSession', object:result._id}, function(){});
          self.qufox.send('session:' + result._id, {name:'joinSession', object:self.data.me.id}, function(){});
          self.addSession(result);
        }

        if (_.isFunction(callback)) callback(err, result);
      });
    };

    BongtalkViewModel.prototype.joinSession = function (sessionId, callback) {
      var self = this;
      self.apiClient.joinSession(sessionId, function (err, result){
        if (err){
          if (_.isFunction(callback)) callback(err, result);
        }
        else{
          self.qufox.send('private:' + self.data.me.id, {name:'joinSession', object:sessionId}, function(){});
          self.qufox.send('session:' + sessionId, {name:'joinSession', object:self.data.me.id}, function(){});
          self.apiClient.getSession(sessionId, function(err, result) {
            if (!err){
              self.addSession(result);
            }

            if (_.isFunction(callback)) callback(err, result);
          });
        }
      });
    };

    BongtalkViewModel.prototype.leaveSession = function (sessionId, callback) {
      var self = this;
      self.apiClient.leaveSession(sessionId, function (err, result){
        if (err) {
          if (_.isFunction(callback)) callback(err, result);
        }
        else {
          self.qufox.send('private:'+self.data.me.id, {name:'leaveSession', object:sessionId}, function(){});
          self.qufox.send('session:'+sessionId, {name:'leaveSession', object:self.data.me.id}, function(){});
          self.removeSession(sessionId);
          if (_.isFunction(callback)) callback(err, result);
        }
      });
    };

    BongtalkViewModel.prototype.sendTelegram = function (session, telegram, callback) {
      var self = this;
      if (!session || !telegram) return;

      self.addTelegram(session, telegram);
      self.apiClient.addTelegram(session._id, telegram.userName, telegram.type, telegram.subType, telegram.data, function (err, result) {
        if (err) {
          if (_.isFunction(callback)) callback(err, result);
        }
        else {
          // update real id and time.
          telegram._id = result._id;
          telegram.time = result.time;

          // Send packet.
          self.qufox.send('session:' + session._id, {name:'telegram',object:result}, function () {
            if (_.isFunction(callback)) callback(err, result);
          });
        }
      });
    };

    BongtalkViewModel.prototype.addTelegram = function (session, telegram) {
      var self = this;
      if (!session) { return; }
      if (angular.isArray(session.telegrams)) {
        var existsTelegram = _.find(session.telegrams, function (t) { return t._id == telegram._id; });
        if (!existsTelegram) {
          session.telegrams.push(telegram);
        }
      }
      else {
        session.telegrams = [telegram];
      }

      return telegram;
    };

    // Add Session
    BongtalkViewModel.prototype.addSession = function (session) {
      var self = this;
      // Add to SessionList
      if (!_.find(self.data.sessionList, function (s) { return s._id == session._id; })) {
        self.data.sessionList.push(session);
        self.qufox.join('session:' + session._id, function (packet) {
          self.sessionPacketReceived(session, packet);
        });
      }

      // setUserInfo
      if (self.data.me.sessions.indexOf(session._id) == -1) {
        self.data.me.sessions.push(session._id);
      }
    };

    // Remove Session
    BongtalkViewModel.prototype.removeSession = function (sessionId) {
      var self = this;
      // remove from SessionList
      var index = _.findIndex(self.data.sessionList, function (s) { return s._id == sessionId; });
      if (index > -1) {
        var session = self.data.sessionList.splice(index, 1);
        if (session) {
          self.qufox.leave('session:' + session._id);
        }
      }

      // setUserInfo
      var index = self.data.me.sessions.indexOf(sessionId);
      if (index > -1) {
        self.data.me.sessions.splice(index, 1);
      }
    };

    BongtalkViewModel.prototype.privatePacketReceived = function (packet) {
      var self = this;
      if (!self.data || !packet.object) return;
      self.$rootScope.$apply(function () {
        switch (packet.name) {
          case 'setMyInfo':
          self.updateUser(packet.object);
          break;
          case 'joinSession':
          var sessionId = packet.object;
          if (!_.find(self.data.sessionList, function (s) { return s._id == sessionId; })) {
            self.apiClient.getSession(sessionId, function (err, result) {
              if (!err) self.addSession(result);
            });
          }
          break;
          case 'leaveSession':
          self.removeSession(packet.object);
          // if your url in receive session, leave.
          if (self.$routeParams.left == 'chats'&&
            (self.$routeParams.right == 'session' || self.$routeParams.right == 'session-info') &&
            self.$routeParams.param == packet.object) {
            self.$location.path('/main/chats');
          }
          break;
        }
      });
    };

    // [Qufox] Receive Session Packet
    BongtalkViewModel.prototype.sessionPacketReceived = function (session, packet) {
      var self = this;
      self.$rootScope.$apply(function () {
        switch (packet.name) {
          case 'telegram':
            // add Telegram
            self.addTelegram(session, packet.object);
            break;
          case 'updateUser':
            // update only others info. (my info will update by privatePacket.)
            if (packet.object.id != self.data.me.id){
              self.updateUser(packet.object);
            }
            break;
          case 'joinSession':
            var joinedUserId = packet.object;
            // only other users.
            if (joinedUserId != self.data.me.id){
              // Add to session.users
              if (_.findIndex(session.users, function (uId){return uId == joinedUserId;}) === -1){
                session.users.push(joinedUserId);
              }
              // Update userList
              self.apiClient.getUser(joinedUserId, function (err, user){
                if (!err) self.updateUser(user);
              });
            }
            break;
          case 'leaveSession':
            var leavedUserId = packet.object;
            if (leavedUserId != self.data.me.id){
              // remove in session.users
              var userIndex = _.findIndex(session.users, function (uId){return uId == leavedUserId;});
              if (userIndex > -1) {
                session.users.splice(userIndex, 1);
              }
              // remove session in user
              var leavedUser = _.find(self.data.userList, function (u){return u.id == leavedUserId;});
              if (leavedUser && leavedUser.sessions && leavedUser.sessions.length){
                var sessionIndex = _.findIndex(leavedUser.sessions, function(s){return s == session._id;});
                if (sessionIndex > -1){
                  leavedUser.sessions.splice(sessionIndex, 1);
                }
              }
            }
            break;
        }
      });
    };

    // Random 문자열 만들기.
    BongtalkViewModel.prototype.randomString = function (length) {
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
    };

    return BongtalkViewModel;
  })();

}.call(this));
