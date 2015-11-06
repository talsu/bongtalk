'use strict';

/* Controllers */

var bongtalkControllers = angular.module('bongtalk.controllers', []);

bongtalkControllers.controller('BootController', ['$scope', '$routeParams', '$cookies', '$location', 'ngDialog', 'bongtalk', 'emitter',
function ($scope, $routeParams, $cookies, $location, ngDialog, bongtalk, emitter) {
  $scope.checkLogin(function (user) {
    $location.path('/main/chats');
  });
}]);

bongtalkControllers.controller('MainController', ['$window', '$rootScope', '$scope', '$routeParams', '$cookies', '$location', 'ngDialog', 'bongtalk', 'bongtalkAutoRefreshToken', 'emitter',
function($window, $rootScope, $scope, $routeParams, $cookies, $location, ngDialog, bongtalk, bongtalkAutoRefreshToken, emitter) {
  $scope.routeLeft = $routeParams.left || 'chats';
  $scope.routeRight = $routeParams.right;
  $scope.routeParam = $routeParams.param;

  $scope.isRightMain = ($routeParams.right && $routeParams.right != 'none');

  $scope.checkLogin(function (user) {
    if (!$scope.vm.isLoaded) {
      $scope.vm.load(user, function (err, result) {
        if (err) {
          //alert.add('Error', err);
          alert(err);
        }
        else {
          init();
        }
      });
    }
    else {
      init();
    }
  });

  function init() {
    emitter.on('focusArea', onFocusArea);

    $scope.$on('$destroy', function () {
      emitter.off('focusArea', onFocusArea);
    });
  }

  function onFocusArea (isRight) {
    $scope.isRightMain = isRight;
  }
}]);

bongtalkControllers.controller('ConnectionStatusController', ['$scope', '$routeParams', '$http', 'bongtalk', 'emitter',
function($scope, $routeParams, $http, bongtalk, emitter) {

  $scope.serverStatus = $scope.vm.qufox.status;

  $scope.vm.qufox.onStatusChanged(serverStatusChanged);
  function serverStatusChanged (status){
    $scope.$apply(function(){
      $scope.serverStatus = status;
    });
  };
}]);
