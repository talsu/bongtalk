
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
      this.qufox = new Qufox(window.location.protocol + '//' + window.location.host);
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
      if (!user) { callback('user is no exist', null); return; }
      self.apiClient.getUserSessions(user.id, function (err, result) {
        if (!err) {
          self.data = { me: user, sessionList: result, userList: [user] };
          // token auto refresh service Start.
          self.bongtalkAutoRefreshToken.start();
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
        }

        // call ready callback.
        if (_.isFunction(callback)) callback(err, result);
        if (self.readyCallbackList.length > 0) {
          _.each(self.readyCallbackList, function (readyCallback) {
            readyCallback(err, result);
          });
        }
      });
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
          self.qufox.send('private:' + self.data.me.id, {name:'setMyInfo', object:data}, function(){});
        }
        if (_.isFunction(callback)) callback(err, result);
      });
    };

    BongtalkViewModel.prototype.updateUser = function (user){
      for (var property in user) {
        this.data.me[property] = user[property];
      }
    };

    BongtalkViewModel.prototype.addOrUpdateUser = function (user){
      // TODO 사용자 리스트 관리
      console.log(user);
    };

    BongtalkViewModel.prototype.loadUsers = function (session, callback) {
      var self = this;
      if (!session) return;

      self.apiClient.getSessionUsers(session._id, function (err, result) {
        if (!err) {
          session.users = result;
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
          if (result.telegrams && result.telegrams.length > 0){
            _.each(result.telegrams, function (telegram) {
              self.addTelegram(session, telegram);
            });
          }

          if (result.users && result.users.length > 0){
            _.each(result.users, function (user){
              self.addOrUpdateUser(user);
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
          self.addSession(result);
        }

        if (_.isFunction(callback)) callback(err, result);
      });
    };

    BongtalkViewModel.prototype.joinSession = function (sessionId, callback) {
      var self =this;
      self.apiClient.joinSession(sessionId, function (err, result){
        if (err){
          if (_.isFunction(callback)) callback(err, result);
        }
        else{
          self.qufox.send('private:' + self.data.me.id, {name:'joinSession', object:sessionId}, function(){});
          self.apiClient.getSession(sessionId, function(err, result) {
            if (!err){
              self.addSession(result);
            }

            if (_.isFunction(callback)) callback(err, result);
          });
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
          self.qufox.send('session:' + session._id, result, function () {
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
          if (self.$routeParams.left == 'chats'
            && (self.$routeParams.right == 'session' || self.$routeParams.right == 'session-info')
            && self.$routeParams.param == packet.object) {
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
        var telegram = self.addTelegram(session, packet);
        //var talk = self.addTalk(session, packet);

        //// ping 을 받으면 pong 을 보낸다.
        //if (talk.type == 'ping') self.sendTalk(session.sessionId, 'pong', navigator.userAgent.substring(0, 200));

        //// 상대방이 전송한 일반메시지 수신
        //if (!packet.type && packet.userId != self.data.UserId) {
        //    // 현재 보고 있는 Session 이면 ACK_READ 아니면 ACK를 보낸다.
        //    var method = self.$routeParams.sessionId == session.sessionId ? 'ACK_READ' : 'ACK';
        //    self.sendFlowTalk(session.sessionId, method, packet.id);
        //}
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
