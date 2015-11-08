
angular.module('bongtalk.filters', [])
.filter('timespan', function () {
  function zeroPad(nr, base) {
    if (_.isNaN(nr) || nr < 0) nr = 0;
    var len = (String(base).length - String(nr).length) + 1;
    return len > 0 ? new Array(len).join('0') + nr : nr;
  }
  return function (ms) {
    if (_.isNaN(ms) || ms < 0) ms = 0;
    var sec_num = Math.floor(ms / 1000);
    var hours = Math.floor(sec_num / 3600);
    var minutes = Math.floor((sec_num - (hours * 3600)) / 60);
    var seconds = sec_num - (hours * 3600) - (minutes * 60);

    return [zeroPad(hours, 10), zeroPad(minutes, 10), zeroPad(seconds, 10)].join(':');;
  };
})
.filter('visibleTalk', function () {
  return function (talks) {
    if (angular.isArray(talks)) {
      return _.filter(talks, function (talk) { return !talk.type || talk.type == 'file'; });
    }
    return talks;
  };
})
.filter('isWaitingSession', function () {
  return function (sessionList) {
    if (angular.isArray(sessionList)) {
      return _.filter(sessionList, function (session) {
        return !(session.talkStartTimeLong || (!session.talkStartTimeLong && session.operatorId));
      });
    }
    return sessionList;
  };
})
.filter('isConnectedSession', function () {
  return function (sessionList) {
    if (angular.isArray(sessionList)) {
      return _.filter(sessionList, function (session) {
        return session.talkStartTimeLong || (!session.talkStartTimeLong && session.operatorId);
      });
    }
    return sessionList;
  };
})
.filter('lastTalkTelegram', function () {
  return function (telegrams) {
    if (angular.isArray(telegrams) && telegrams.length > 0) {
      var talks = _.filter(telegrams, function (t) { return t.type == 'talk'; })
      var lastTalkTelegram = _.max(talks, function (t) { return t.time; });
      return lastTalkTelegram;
      // if (lastTalkTelegram) {
      //   var senderName = lastTalkTelegram.userId == myId ? 'YOU' : lastTalkTelegram.userName;
      //   return senderName + ': ' + lastTalkTelegram.data;
      // }
    }
    return null;
  };
})
.filter('telegramMessage', function () {
  return function (telegram, myId) {
    if (telegram){
        var senderName = telegram.userId == myId ? 'YOU' : telegram.userName;
        return senderName + ': ' + telegram.data;
    }
    return;
  };
})
.filter('telegramTime', function () {
  return function (telegram, myId) {
    if (telegram){
        return telegram.time;
    }
    return;
  };
})
.filter('unreadCount', function () {
  return function (talks, operatorId) {
    if (!talks || !angular.isArray(talks)) return null;
    var unreadTalks = _.filter(talks, function (t) { return !t.type && t.userId != operatorId && !t.isRead; });
    return unreadTalks.length;
  };
});
