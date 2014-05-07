define(['app'], function(app){
	app.factory('item', ['$resource', function ($resource){
		return $resource('item/:id', {id: '@id'});
	}]);
});